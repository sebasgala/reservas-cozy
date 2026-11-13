import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { etiquetaHabitacion, evaluarVentanaCheckin, generarClaveDigital, mismoDocumento, totalConsumosCentavos } from './checkin';
import { centavosAMoney } from '../../comun/v2/dinero';
import { CheckInV2Dto, CheckOutV2Dto, EarlyCheckinV2Dto } from './dto/estancia-v2.dto';
import { EventosService } from '../../comun/v2/eventos.service';
import { OrdenesV2Service } from './ordenes-v2.service';
import { peticionInvalida, ProblemaV2Exception, reglaDeNegocio } from '../../comun/v2/problemas-v2';
import { ConflictoException } from '../../comun/problems/problem-details.exceptions';
import { registrarV2 } from '../../comun/v2/registro-v2';
import { isoGuayaquil } from '../../comun/v2/reloj';
import { nochesDe } from '../../disponibilidad/disponibilidad.puerto';
import { AvisoStock, SagaReservaService } from './saga-reserva.service';
import { BookingCheckinClient } from './booking-checkin.client';
import { CONEXION } from '../../../database/conexiones';
import { HabitacionesFisicasService } from '../admin/habitaciones-fisicas.service';

// Estancia del contrato v2 (§4):
//   POST /orders/{ref}/check-in       solo CONFIRMED y desde las 14:00 de Guayaquil del día de llegada (o con early check-in)
//   PUT  /orders/{ref}/early-checkin  lo fija solo un administrador; idempotente
//   POST /orders/{ref}/checkout       solo desde CHECKED_IN; liquida consumos y revoca la clave digital
//
// Cada paso bloquea la fila de la orden (SELECT … FOR UPDATE): dos check-in simultáneos no pasan los dos, y el segundo ve
// CHECKED_IN y recibe 409. El evento (CloudEvents) se escribe en la MISMA transacción, al final, para que su `sequence`
// siga el orden de commit. Los eventos no llevan datos personales ni la clave digital.
// Fase 8.2: buscar la reserva, autorizar (un administrador pregunta al catálogo de quién es el alojamiento) y leer la
// habitación para el aviso de stock van ANTES de abrir la transacción; dentro solo se bloquea la fila por id.
@Injectable()
export class EstanciaV2Service {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly ordenes: OrdenesV2Service,
    private readonly eventos: EventosService,
    private readonly sagas: SagaReservaService,
    private readonly habitacionesFisicas: HabitacionesFisicasService,
    @Optional() private readonly bookingClient?: BookingCheckinClient,
  ) {}

  // ───────────────────────── POST /orders/{ref}/check-in ─────────────────────────
  async checkIn(ref: string, dto: CheckInV2Dto, principal: PrincipalV2, ahora: Date, correlacion: string | null) {
    const encontrada = await this.ordenes.localizar(ref, principal);
    const resultadoLocal = await this.dataSource.transaction(async (manager) => {
      const orden = await this.bloquear(manager, encontrada);
      if (orden.status !== OrdenStatus.CONFIRMED) {
        throw new ProblemaV2Exception(409, 'INVALID_STATE_TRANSITION', `No se puede hacer check-in de una reserva en estado ${orden.status}.`);
      }
      const titular = orden.huespedTitular as Record<string, any> | null;
      const docRegistrado = titular?.identificacion ?? titular?.document_id ?? titular?.cedula ?? titular?.numeroIdentificacion ?? null;
      if (!mismoDocumento(dto.titularIdentificacion, docRegistrado)) {
        throw reglaDeNegocio('INVALID_DOCUMENT', 'titularIdentificacion no corresponde al titular de la reserva.', [
          { name: 'titularIdentificacion', reason: 'no coincide con el titular de la reserva' },
        ]);
      }
      const ventana = evaluarVentanaCheckin(
        { checkinFecha: orden.checkin, checkoutFecha: orden.checkout, earlyAutorizado: orden.earlyCheckinAutorizado, earlyDesde: orden.earlyCheckinDesde ? new Date(orden.earlyCheckinDesde) : null },
        ahora,
      );
      if (ventana.estado === 'AUN_NO') {
        throw reglaDeNegocio('CHECKIN_TIME_NOT_REACHED', 'El check-in digital se habilita a partir de las 14:00 (hora de Guayaquil) del día de llegada.', [], {
          habilitadoDesde: isoGuayaquil(ventana.habilitadoDesde),
        });
      }
      if (ventana.estado === 'VENCIDA') {
        throw reglaDeNegocio('VALIDATION_FAILED', `El check-in solo se puede hacer hasta el ${orden.checkout}: la estancia terminó.`, [{ name: 'orderId', reason: `la ventana de check-in cerró el ${orden.checkout}` }]);
      }

      // Bloque R: si el alojamiento controla limpieza, exigir habitación LIMPIA disponible
      const controlaLimpieza = await this.habitacionesFisicas.verificaControlaLimpieza(manager, orden.alojamientoId);
      let habitacionFisicaAsignada: string | null = null;
      if (controlaLimpieza) {
        const hf = await this.habitacionesFisicas.asignarYOcupar(manager, orden.alojamientoId, orden.habitacionId, orden.id, null).catch((e) => {
          if (e instanceof ConflictoException) throw new ProblemaV2Exception(409, 'ROOM_NOT_AVAILABLE', e.message);
          throw e;
        });
        habitacionFisicaAsignada = hf.id;
      }

      orden.status = OrdenStatus.CHECKED_IN;
      orden.checkInEn = ahora;
      orden.habitacionFisicaId = habitacionFisicaAsignada;
      orden.habitacionAsignada = etiquetaHabitacion(orden.habitacionNombre, orden.id);
      orden.claveAccesoDigital = generarClaveDigital();
      if (dto.peticionesEspeciales) {
        orden.peticionesEspeciales = [orden.peticionesEspeciales, dto.peticionesEspeciales].filter(Boolean).join(' | ');
      }
      await manager.save(orden);
      await this.eventos.emitir(
        manager,
        [
          {
            tipo: 'alojamiento.checkin.completado',
            sujeto: `orders/${orden.id}`,
            alojamientoId: orden.alojamientoId,
            datos: {
              orderId: orden.id,
              external_order_id: `ORD-HTL-${orden.locator}`,
              estado: 'CHECKED_IN',
              alojamientoId: orden.alojamientoCodigo,
              tipoHabitacionCodigo: orden.habitacionCodigo,
              checkInHora: isoGuayaquil(ahora),
            },
          },
        ],
        correlacion,
      );
      const base = `/api/v2/alojamientos/orders/${orden.id}`;
      return {
        reservaId: orden.id,
        estado: 'CHECKED_IN' as const,
        habitacionAsignada: orden.habitacionAsignada,
        claveAccesoDigital: orden.claveAccesoDigital,
        checkInHora: isoGuayaquil(ahora),
        instruccionesAcceso: 'Acerca el teléfono a la cerradura e ingresa el PIN. La clave se revoca en el check-out.',
        _links: { self: { href: base, method: 'GET' }, checkOut: { href: `${base}/checkout`, method: 'POST' } },
      };
    });

    // Notificación saliente a Booking (Paso 5): disparada SOLO tras confirmar localmente con éxito
    if (this.bookingClient) {
      try {
        const ninos = Array.isArray(encontrada.guests?.children) ? (encontrada.guests.children as number[]).length : 0;
        const adultos = Number(encontrada.guests?.number_of_adults ?? 1);
        const huespedesReales = Math.max(1, adultos + ninos);

        const payloadBooking = this.bookingClient.construirPayload({
          external_order_id: `ORD-HTL-${encontrada.locator}`,
          client_id: encontrada.clienteId ?? encontrada.id,
          huespedes_reales: huespedesReales,
          admin_id: principal.usuarioId ?? 'admin-recepcion',
          fecha_checkin: ahora,
          observaciones: dto.peticionesEspeciales ?? null,
        });

        const resBooking = await this.bookingClient.notificarCheckin(payloadBooking, correlacion);
        // Notificación deshabilitada (sin clave): no es un fallo, no se deja reintento pendiente
        if (!resBooking.omitido) {
          await this.bookingClient.guardarResultado(encontrada.id, payloadBooking, resBooking, correlacion);
        }
      } catch (err) {
        await this.bookingClient.guardarResultado(
          encontrada.id,
          null,
          { exito: false, error: (err as Error).message },
          correlacion,
        );
      }
    }

    return resultadoLocal;
  }

  // ───────────────────────── PUT /orders/{ref}/early-checkin ─────────────────────────
  async earlyCheckin(ref: string, dto: EarlyCheckinV2Dto, principal: PrincipalV2, ahora: Date, correlacion: string | null) {
    const encontrada = await this.ordenes.localizar(ref, principal);
    return this.dataSource.transaction(async (manager) => {
      const orden = await this.bloquear(manager, encontrada);
      if (orden.status !== OrdenStatus.CONFIRMED) {
        throw new ProblemaV2Exception(409, 'INVALID_STATE_TRANSITION', `No se puede autorizar el early check-in de una reserva en estado ${orden.status}.`);
      }
      orden.earlyCheckinAutorizado = dto.autorizado;
      orden.earlyCheckinDesde = dto.autorizado ? (dto.habilitadoDesde ? new Date(dto.habilitadoDesde) : ahora) : null;
      orden.earlyCheckinMotivo = dto.autorizado ? (dto.motivo ?? null) : null;
      await manager.save(orden);
      registrarV2('info', 'early_checkin', { correlationId: correlacion, orderId: orden.id, autorizado: dto.autorizado, porUsuario: principal.usuarioId ?? null });
      return this.ordenes.aDetalle(orden, true);
    });
  }

  // ───────────────────────── POST /orders/{ref}/checkout ─────────────────────────
  async checkOut(ref: string, dto: CheckOutV2Dto, principal: PrincipalV2, ahora: Date, correlacion: string | null) {
    const encontrada = await this.ordenes.localizar(ref, principal);
    const habitacion = await this.ordenes.habitacionParaStock(encontrada.habitacionId);
    // El aviso de stock a Booking sale cuando la transacción del check-out ya se confirmó (8.5): si esa falla no queda ningún aviso
    const pendiente: { aviso?: AvisoStock } = {};
    const respuesta = await this.dataSource.transaction(async (manager) => {
      const orden = await this.bloquear(manager, encontrada);
      if (orden.status !== OrdenStatus.CHECKED_IN) {
        throw new ProblemaV2Exception(409, 'INVALID_STATE_TRANSITION', `El check-out solo se puede hacer desde CHECKED_IN (la reserva está ${orden.status}).`);
      }
      const consumos = dto.consumosMinibar ?? [];
      const totalCentavos = totalConsumosCentavos(consumos);
      if (totalCentavos === null) {
        throw peticionInvalida([{ name: 'consumosMinibar', reason: 'el total de los consumos supera el máximo que admite un importe' }]);
      }
      const liberada = orden.habitacionAsignada ?? '';
      // Fase 2: el check-out NO finaliza la reserva; pasa a POR_LIMPIAR y sigue visible en recepción (archivada = false).
      // La habitación física queda SUCIA/bloqueada hasta que recepción la marque limpia (marcarHabitacionLista).
      orden.status = OrdenStatus.POR_LIMPIAR;
      orden.archivadaRecepcion = false;
      orden.checkOutEn = ahora;
      orden.consumos = consumos.map((c) => ({ item: c.item, cantidad: c.cantidad ?? 1, precio: c.precio }));
      orden.consumosAdicionales = totalCentavos / 100;
      orden.metodoPagoConsumos = consumos.length > 0 ? (dto.metodoPagoConsumos ?? 'CARGO_A_RESERVA') : null;
      orden.claveAccesoDigital = null; // revocada
      await manager.save(orden);
      // Bloque R: si había habitación física asignada, marcarla como SUCIA en la misma transacción (deja su historial)
      if (orden.habitacionFisicaId) {
        await this.habitacionesFisicas.marcarSucia(manager, orden.habitacionFisicaId, orden.id);
      }
      // La habitación se libera: Booking recibe el stock de las noches que quedan (las pasadas no se avisan), pero solo cuando
      // esta transacción se confirme
      pendiente.aviso = { habitacion, fechas: nochesDe(orden.checkin, orden.checkout), motivo: 'ESTADO', ordenId: orden.id, correlacion };
      await this.eventos.emitir(
        manager,
        [
          {
            tipo: 'alojamiento.checkout.completado',
            sujeto: `orders/${orden.id}`,
            alojamientoId: orden.alojamientoId,
            datos: {
              orderId: orden.id,
              external_order_id: `ORD-HTL-${orden.locator}`,
              estado: 'CHECKED_OUT',
              alojamientoId: orden.alojamientoCodigo,
              tipoHabitacionCodigo: orden.habitacionCodigo,
              checkin: orden.checkin,
              checkout: orden.checkout,
              checkOutHora: isoGuayaquil(ahora),
              consumosAdicionales: centavosAMoney(totalCentavos),
              // El inventario FÍSICO no se libera aquí: la habitación queda SUCIA hasta marcarse limpia (habitacion.limpia.lista)
              inventarioFisicoLiberado: false,
            },
          },
        ],
        correlacion,
      );
      return {
        orderId: orden.id,
        estado: 'CHECKED_OUT' as const,
        habitacionLiberada: liberada,
        checkOutHora: isoGuayaquil(ahora),
        consumosAdicionales: centavosAMoney(totalCentavos),
        claveDigitalRevocada: true,
        _links: { orden: { href: `/api/v2/alojamientos/orders/${orden.id}`, method: 'GET' } },
      };
    });
    if (pendiente.aviso) await this.sagas.avisarStockTrasCommit(pendiente.aviso);
    return respuesta;
  }

  // Bloquea la fila de la reserva ya localizada y autorizada (OrdenesV2Service.localizar) hasta el commit
  private async bloquear(manager: EntityManager, encontrada: Orden): Promise<Orden> {
    const orden = await manager.getRepository(Orden).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: encontrada.id }).getOne();
    return orden;
  }
}

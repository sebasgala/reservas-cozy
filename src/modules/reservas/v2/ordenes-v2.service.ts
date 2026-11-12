import { randomInt, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { calcularNoches, huellaDePeticion } from '../../comun/alojamientos-consulta.utils';
import { AlojamientoCatalogo, CatalogoPuerto, HabitacionCatalogo, RefHabitacionStock } from '../../catalogo/catalogo.puerto';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { aCentavos, centavosAMoney, metadataPagina, moneyACentavos } from '../../comun/v2/dinero';
import { DesgloseV2, DisponibilidadPuerto, evaluarRestricciones, nochesDe, Ocupacion, PLAN_ESTANDAR, PoliticaCancelacion, ResultadoReserva } from '../../disponibilidad/disponibilidad.puerto';
import { motivoDocumentoInvalido, TipoDocumento } from './documentos';
import { CancelarOrdenV2Dto, CrearOrdenV2Dto, ListarOrdenesV2Query } from './dto/ordenes-v2.dto';
import { PaginaV2Query } from '../../catalogo/v2/dto/catalogo-v2.dto';
import { exigirUsd, validarEstancia } from '../../comun/v2/estancia';
import { IdempotenciaV2Service, RespuestaIdempotente } from './idempotencia-v2';
import { politicaDeCancelacion, regimenDeMealPlan } from '../../comun/v2/mapeos-v2';
import { calcularPrecio, divisionHalfUp } from '../../comun/v2/precios';
import { noEncontrado, ProblemaV2Exception, reglaDeNegocio } from '../../comun/v2/problemas-v2';
import { estaVigente, fechaGuayaquil, instanteGuayaquil, isoGuayaquil } from '../../comun/v2/reloj';
import { checkinHabilitadoDesde, HORA_CHECKIN } from './checkin';
import { descuentoEnCentavos, validarPaqueteContraAcuerdo } from './promociones';
import { PromocionesV2Service } from './promociones-v2.service';
import { EventosService } from '../../comun/v2/eventos.service';
import { correrSaga } from './saga-reserva';
import { CancelacionPendiente, MOTIVO_SAGA_COMPENSADA, SagaReservaService } from './saga-reserva.service';
import { CONEXION } from '../../../database/conexiones';

// Órdenes del contrato v2 (§3, contrato síncrono de la Saga):
//   POST /orders/create          crea la reserva y descuenta el cupo, idempotente (≤ 3 s)
//   GET  /orders/{ref}           detalle; ref = UUID, ORD-HTL-… o BK-HOTEL-…
//   GET  /orders                 recuperación tras un timeout (saga_id, idempotency_key, external_order_id) y conciliación
//   POST /orders/{ref}/cancel    cancelación compensatoria, idempotente; devuelve el cupo
//   GET  /reservations           reservas del usuario del token
//
// Sobreventa: ReservarCupos (disponibilidad) bloquea las noches de la habitación (SELECT … FOR UPDATE, en orden de
// fecha), comprueba el cupo y lo descuenta con la orden como clave. Dos compras por la última habitación pasan de a
// una: la segunda ve cupo 0 y recibe 409 OUT_OF_STOCK. Cancelar llama a LiberarCupos con la misma clave.
// Fase 8.4: la compra es una saga (crear, más abajo) y cada llamada a disponibilidad corre en su propia transacción.
// Del catálogo solo se lee por su puerto; lo que la orden muestra se copia en ella al reservar (fase 8.0).
// Fase 8.2: esas lecturas van en la fase `preparar` de la idempotencia, antes de abrir la transacción; dentro solo se
// decide con lo leído, en el mismo punto y con el mismo error que antes.

const ALFABETO_LOCATOR = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_LOCATOR = 8;
const LIMITE_RETRASO_PRUEBA_MS = 5000;

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

const llegada = instanteGuayaquil;

// Lo que `preparar` deja listo para la transacción final de la compra
interface CompraPreparada {
  ordenId: string;
  sagaId: string;
  correlacion: string | null;
  // Para el aviso de stock, que sale DESPUÉS de confirmar la transacción de la reserva (8.4)
  habitacion: RefHabitacionStock | null;
  noches: string[];
  // La saga ya había avisado el stock (por ejemplo, la cerró el barrido): no se avisa otra vez
  avisada: boolean;
}

interface CatalogoDeLaCompra {
  alojamiento: AlojamientoCatalogo | null;
  habitacion: HabitacionCatalogo | null;
}

interface Titular {
  nombreCompleto: string;
  tipoDocumento: TipoDocumento;
  identificacion: string;
  email: string;
  telefono: string;
  nacionalidad?: string;
}

@Injectable()
export class OrdenesV2Service {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly disponibilidad: DisponibilidadPuerto,
    private readonly catalogo: CatalogoPuerto,
    private readonly idempotencia: IdempotenciaV2Service,
    private readonly eventos: EventosService,
    private readonly promociones: PromocionesV2Service,
    private readonly sagas: SagaReservaService,
  ) {}

  // ───────────────────────── POST /orders/create ─────────────────────────
  // Saga de 8.4 (decisión 1, orquestada por reservas): cada paso corre en la transacción de su dominio.
  //   1. validar (lecturas)  2. retener cupos (disponibilidad, provisional)  3. orden PENDING (reservas)
  //   4a. confirmar la retención, SIN aviso de stock (disponibilidad)  — desde aquí la saga se termina hacia adelante —
  //   4b. orden CONFIRMED, evento y respuesta idempotente (reservas, la transacción de IdempotenciaV2Service)
  //   5. aviso de stock a Booking: solo cuando 4b ya se confirmó
  // Pasos 1 a 4a en `preparar` (con la Idempotency-Key ya tomada, antes de la transacción final); 4b en `procesar`.
  // Si falla algo antes de 4a, se compensan los pasos hechos (saga-reserva.ts) y se responde el error real. Si falla 4b, no
  // queda ningún aviso de stock; el reintento o el barrido la terminan. Si falla 5, la orden ya confirmada se responde igual
  // (201) y el barrido avisa.
  async crear(dto: CrearOrdenV2Dto, clave: string, principal: PrincipalV2, ahora: Date, retrasoPruebaMs = 0, correlacion: string | null = null): Promise<RespuestaIdempotente> {
    const huella = huellaDePeticion({ operacion: 'createOrder', cuerpo: dto });
    const hecho: { compra?: CompraPreparada } = {};
    const respuesta = await this.idempotencia.ejecutar<CompraPreparada>(
      clave,
      'createOrder',
      huella,
      ahora,
      (manager, compra) => this.confirmarCompra(manager, compra),
      async () => (hecho.compra = await this.prepararCompra(dto, clave, principal, ahora, retrasoPruebaMs, correlacion)),
    );
    // Una respuesta repetida no pasó por aquí; una saga ya avisada tampoco se avisa otra vez
    const compra = hecho.compra;
    if (compra && !respuesta.repetida && !compra.avisada) {
      await this.sagas.avisarReserva(compra.sagaId, compra.ordenId, compra.habitacion, compra.noches, compra.correlacion);
    }
    return respuesta;
  }

  private async prepararCompra(dto: CrearOrdenV2Dto, clave: string, principal: PrincipalV2, ahora: Date, retrasoPruebaMs: number, correlacion: string | null): Promise<CompraPreparada> {
    // Lo que la compra necesita del catálogo, leído fuera de transacción (los 404 se deciden aquí abajo)
    const { alojamiento, habitacion } = await this.catalogoDeLaCompra(dto);
    const lectura = this.dataSource.manager;

    // ── 1. Validar: nada de esto escribe ──
    if (dto.idempotency_key && dto.idempotency_key.toLowerCase() !== clave) {
      throw reglaDeNegocio('VALIDATION_FAILED', 'idempotency_key (deprecado) debe ser igual a la cabecera Idempotency-Key.', [
        { name: 'idempotency_key', reason: 'no coincide con la cabecera Idempotency-Key' },
      ]);
    }
    const noches = validarEstancia(dto.fechaInicio, dto.fechaFin);
    exigirUsd(dto.currency);
    const titular = this.titular(dto);
    const habitaciones = dto.cantidadHabitaciones ?? 1;
    const ocupacion = this.disponibilidad.ocupantes(dto.ocupantes, 'ocupantes');

    if (!alojamiento) throw noEncontrado(`No existe el alojamiento '${dto.alojamientoId}'.`);
    // Combo: se valida contra el acuerdo B2B vigente antes de tocar el inventario (acuerdo, vigencia, destino, porcentaje)
    if (dto.paquete) {
      validarPaqueteContraAcuerdo(await this.promociones.acuerdo(lectura), dto.paquete, alojamiento.ciudadNombre, fechaGuayaquil(ahora));
    }
    if (!habitacion) throw noEncontrado(`El alojamiento '${dto.alojamientoId}' no tiene el tipo de habitación '${dto.tipoHabitacionCodigo}'.`);
    const codigoPlan = dto.planTarifaCodigo ?? PLAN_ESTANDAR;
    const plan = (await this.disponibilidad.planes([habitacion])).get(habitacion.id).find((p) => p.codigo === codigoPlan);
    if (!plan) throw noEncontrado(`La habitación '${habitacion.codigo}' no tiene el plan de tarifa '${codigoPlan}'.`);
    if (dto.regimenSeleccionado && dto.regimenSeleccionado !== plan.regimen) {
      throw reglaDeNegocio('VALIDATION_FAILED', `El plan ${plan.codigo} ofrece ${plan.regimen}, no ${dto.regimenSeleccionado}.`, [
        { name: 'regimenSeleccionado', reason: `el plan ${plan.codigo} es ${plan.regimen}` },
      ]);
    }
    this.disponibilidad.exigirCapacidad(habitacion, ocupacion, habitaciones);

    // Cotización: si viene, el precio queda fijado a ella (si sigue vigente y es de esta misma estancia)
    const cotizacion = dto.cotizacionId ? await this.cotizacionDe(lectura, dto, alojamiento.id, habitacion.id, habitaciones, plan.codigo, ocupacion, ahora) : null;

    const violacion = evaluarRestricciones(noches, dto.fechaFin, (await this.disponibilidad.restricciones([habitacion.id], [...noches, dto.fechaFin])).get(habitacion.id) ?? new Map(), ahora);
    if (violacion) {
      throw reglaDeNegocio('RESTRICTION_VIOLATED', violacion.detalle, [{ name: 'fechaInicio', reason: `${violacion.restriccion} (${violacion.fecha})` }], {
        restriccion: violacion.restriccion,
      });
    }

    // Solo para pruebas (V2_CABECERAS_PRUEBA): mantiene la clave EN_CURSO para probar el 409 de forma determinista
    if (retrasoPruebaMs > 0) await dormir(Math.min(retrasoPruebaMs, LIMITE_RETRASO_PRUEBA_MS));

    const saga = await this.sagas.tomar('createOrder', clave, { correlacion });
    const ordenId = saga.ordenId;
    let reserva: ResultadoReserva | null = null;

    await correrSaga(
      [
        {
          // ── 2. Retener cupos: otra compra de la misma habitación espera aquí a que esta termine su transacción ──
          estado: 'CUPOS_RETENIDOS',
          hacer: async () => {
            reserva = await this.disponibilidad.reservarCupos({ ordenId, habitacionId: habitacion.id, checkin: dto.fechaInicio, checkout: dto.fechaFin, cantidad: habitaciones });
            if (!reserva.ok && reserva.motivo === 'SIN_INVENTARIO') {
              throw new ProblemaV2Exception(409, 'OUT_OF_STOCK', `No hay disponibilidad cargada para '${habitacion.codigo}' en todas las noches pedidas.`);
            }
            if (!reserva.ok) {
              throw new ProblemaV2Exception(409, 'OUT_OF_STOCK', `Sin habitaciones disponibles para las fechas solicitadas: quedan ${reserva.remanentes} '${habitacion.codigo}' y se pidieron ${habitaciones}.`);
            }
          },
          compensar: async () => {
            await this.disponibilidad.liberarCupos(ordenId);
          },
        },
        {
          // ── 3. Orden PENDING con el precio de las noches retenidas (si un intento anterior ya la creó, se usa esa) ──
          estado: 'ORDEN_CREADA',
          hacer: async () => {
            if (await this.sagas.orden(ordenId)) return;
            const filas = reserva!.noches;
            const desgloseSinCombo = cotizacion
              ? (cotizacion.desglose as DesgloseV2)
              : this.disponibilidad.aDesgloseV2(
                  calcularPrecio({
                    noches: filas.map((f) => ({ fecha: f.fecha, precioCentavos: aCentavos(f.precio) })),
                    plan: plan.precio,
                    habitaciones,
                    adultos: ocupacion.adultos,
                    edadesNinos: ocupacion.edadesNinos,
                  }),
                );
            const desglosePrecio = dto.paquete ? this.conDescuentoDeCombo(desgloseSinCombo, dto.paquete) : desgloseSinCombo;
            const totalCentavos = moneyACentavos(desglosePrecio.totalPagar);
            if (moneyACentavos(dto.totalPagar) !== totalCentavos) {
              throw new ProblemaV2Exception(
                409,
                'PRICE_MISMATCH',
                `totalPagar (${dto.totalPagar}) no coincide con el precio ${cotizacion ? 'cotizado' : 'vigente'} (${desglosePrecio.totalPagar}). Vuelve a cotizar.`,
              );
            }
            const [nombre, ...apellidos] = titular.nombreCompleto.trim().split(/\s+/);
            await this.dataSource.transaction(async (manager) => {
              await manager.save(
                manager.create(Orden, {
                  id: ordenId,
                  locator: await this.generarLocator(manager),
                  status: OrdenStatus.PENDING, // pasa a CONFIRMED al confirmar la retención (el pago lo autorizó MS_PAG antes de llamar)
                  alojamientoId: alojamiento.id,
                  habitacionId: habitacion.id,
                  alojamientoCodigo: alojamiento.codigo,
                  alojamientoNombre: alojamiento.nombre,
                  habitacionCodigo: habitacion.codigo,
                  habitacionNombre: habitacion.nombre,
                  habitacionCancellationType: habitacion.cancellationType,
                  habitacionMealPlan: habitacion.mealPlan,
                  previewId: null,
                  habitacionesReservadas: habitaciones,
                  // Mismo formato que la v1, así "Mis reservas" y el panel la muestran igual
                  guests: { number_of_adults: ocupacion.adultos, number_of_rooms: habitaciones, children: ocupacion.edadesNinos },
                  checkin: dto.fechaInicio,
                  checkout: dto.fechaFin,
                  customerFirstName: nombre.slice(0, 120),
                  customerLastName: apellidos.join(' ').slice(0, 120),
                  customerEmail: titular.email.toLowerCase(),
                  totalPrice: totalCentavos / 100,
                  currency: 'USD',
                  paymentReference: dto.payment_reference ?? '',
                  clienteId: principal.rol === 'CLIENTE' ? principal.usuarioId : null,
                  sagaId: dto.saga_id ?? null,
                  claveIdempotencia: clave,
                  cotizacionId: cotizacion?.id ?? null,
                  planTarifaCodigo: plan.codigo,
                  regimen: plan.regimen,
                  modeloPago: plan.modeloPago,
                  metodoPago: dto.payment_method ?? null,
                  huespedTitular: titular,
                  huespedesAdicionales: dto.huespedesAdicionales ? dto.huespedesAdicionales.map((h) => ({ ...h })) : null,
                  peticionesEspeciales: dto.peticionesEspeciales ?? null,
                  desgloseFiscal: this.aDesgloseFiscal(desglosePrecio),
                  politicaCancelacion: plan.politicaCancelacion,
                  paquete: dto.paquete ? { ...dto.paquete } : null,
                }),
              );
              await this.sagas.anotar(saga.id, 'ORDEN_CREADA', undefined, manager);
            });
          },
          compensar: () => this.sagas.compensarOrden(ordenId),
        },
        {
          // ── 4a. Confirmar la retención: deja de vencer. Sin aviso de stock (habitación null): sale en el paso 5 ──
          estado: 'RETENCION_CONFIRMADA',
          hacer: async () => {
            const resultado = await this.disponibilidad.confirmarRetencion(ordenId, null, [], correlacion);
            if (resultado === 'LIBERADA') {
              throw new ProblemaV2Exception(409, 'OUT_OF_STOCK', `La retención de '${habitacion.codigo}' venció antes de confirmar la reserva: vuelve a intentarlo.`);
            }
            if (resultado === 'SIN_RETENCION') throw new Error(`La orden ${ordenId} no tiene retención de cupos`);
          },
          // Si la confirmación llegó a la base pero respondió con error, repetirla (idempotente) lo dice
          comprobar: async () => ['CONFIRMADA', 'YA_CONFIRMADA'].includes(await this.disponibilidad.confirmarRetencion(ordenId, null, [], correlacion)),
        },
      ],
      saga.estado,
      // Una saga ya CONFIRMADA (su aviso de stock ya salió) no vuelve atrás al repetir sus pasos idempotentes
      (estado, detalle) => (saga.estado === 'CONFIRMADA' ? Promise.resolve() : this.sagas.anotar(saga.id, estado, detalle)),
    );
    // Ya pasado el punto sin retorno: la cotización queda usada (idempotente). Si esto falla, el reintento termina hacia adelante.
    if (cotizacion) await this.disponibilidad.marcarCotizacionUsada(cotizacion.id);
    return { ordenId, sagaId: saga.id, correlacion, habitacion, noches, avisada: saga.estado === 'CONFIRMADA' };
  }

  // ── 4b. En la transacción de la respuesta idempotente: orden CONFIRMED y evento. La saga sigue en RETENCION_CONFIRMADA hasta
  // que se avise el stock (paso 5): ahí pasa a CONFIRMADA ──
  private async confirmarCompra(manager: EntityManager, compra: CompraPreparada): Promise<RespuestaIdempotente> {
    const orden = await this.sagas.bloquear(manager, compra.ordenId);
    if (!orden) throw new Error(`No está la orden ${compra.ordenId} de la saga ${compra.sagaId}`);
    await this.sagas.completarAdelante(manager, orden, compra.correlacion);
    return { status: 201, cuerpo: this.aDetalle(orden), cabeceras: { Location: `/api/v2/alojamientos/orders/${orden.id}` } };
  }

  // Lo que la compra necesita del catálogo, leído antes de abrir la transacción (los 404 se deciden en preparar)
  private async catalogoDeLaCompra(dto: CrearOrdenV2Dto): Promise<CatalogoDeLaCompra> {
    const alojamiento = await this.catalogo.alojamientoPorCodigo(dto.alojamientoId, { soloActivo: true });
    const habitacion = alojamiento ? await this.catalogo.habitacionActiva(alojamiento.id, dto.tipoHabitacionCodigo) : null;
    return { alojamiento, habitacion };
  }

  // ───────────────────────── GET /orders/{ref} ─────────────────────────
  async obtener(ref: string, principal: PrincipalV2) {
    const orden = await this.buscar(this.dataSource.manager, ref);
    await this.exigirAcceso(orden, principal);
    return this.aDetalle(orden, principal.rol !== 'SERVICE');
  }

  // ───────────────────────── GET /orders ─────────────────────────
  async listar(q: ListarOrdenesV2Query, principal: PrincipalV2) {
    const consulta = this.dataSource.getRepository(Orden).createQueryBuilder('o');
    if (q.saga_id) consulta.andWhere('o.sagaId = :saga', { saga: q.saga_id });
    if (q.idempotency_key) consulta.andWhere('o.claveIdempotencia = :clave', { clave: q.idempotency_key.toLowerCase() });
    if (q.external_order_id) consulta.andWhere('o.locator = :locator', { locator: q.external_order_id.replace(/^ORD-HTL-/, '') });
    if (q.estado) consulta.andWhere('o.status = :estado', { estado: q.estado });
    if (q.creadoDesde) consulta.andWhere('o.createdAt >= :desde', { desde: q.creadoDesde });
    if (q.creadoHasta) consulta.andWhere('o.createdAt <= :hasta', { hasta: q.creadoHasta });
    // Un administrador ve las de sus alojamientos (Bloque R: del token; sin él, del catálogo)
    if (principal.rol === 'ADMIN' && !principal.superadmin) {
      if (principal.alojamientoId != null) {
        consulta.andWhere('o.alojamientoId = :propio', { propio: principal.alojamientoId });
      } else {
        const suyos = await this.catalogo.idsDeAlojamientosDe(principal.usuarioId);
        consulta.andWhere(suyos.length ? 'o.alojamientoId IN (:...suyos)' : '1 = 0', { suyos });
      }
    }
    const [ordenes, total] = await consulta
      .orderBy('o.createdAt', 'DESC')
      .addOrderBy('o.id', 'ASC')
      .skip((q.page - 1) * q.limit)
      .take(q.limit)
      .getManyAndCount();
    return {
      metadata: metadataPagina(total, q.page, q.limit),
      data: ordenes.map((o) => this.aDetalle(o)),
    };
  }

  // ───────────────────────── GET /reservations ─────────────────────────
  async misReservas(q: PaginaV2Query, principal: PrincipalV2) {
    const [ordenes, total] = await this.dataSource.getRepository(Orden).findAndCount({
      where: { clienteId: principal.usuarioId },
      order: { createdAt: 'DESC', id: 'ASC' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    });
    return {
      metadata: metadataPagina(total, q.page, q.limit),
      data: ordenes.map((o) => ({
        id: o.id,
        reservation_code: `BK-HOTEL-${o.locator}`,
        external_order_id: `ORD-HTL-${o.locator}`,
        accommodation_id: o.alojamientoCodigo,
        accommodation_name: o.alojamientoNombre.slice(0, 150),
        room_type: o.habitacionNombre,
        checkin: o.checkin,
        checkout: o.checkout,
        number_of_rooms: o.habitacionesReservadas,
        guests: { adults: Number(o.guests?.number_of_adults ?? 0), children: Array.isArray(o.guests?.children) ? o.guests.children.length : 0 },
        total_price: centavosAMoney(aCentavos(Number(o.totalPrice))),
        currency: o.currency,
        status: o.status,
        created_at: new Date(o.createdAt).toISOString(),
      })),
    };
  }

  // ───────────────────────── POST /orders/{ref}/cancel ─────────────────────────
  // Los cupos se devuelven y el stock se avisa cuando la transacción de la cancelación ya se confirmó (8.5): si esa falla no se libera
  // ningún cupo (no hay sobreventa) ni queda ningún aviso.
  async cancelar(ref: string, dto: CancelarOrdenV2Dto, clave: string, principal: PrincipalV2, ahora: Date, correlacion: string | null = null): Promise<RespuestaIdempotente> {
    const operacion = `cancelOrder:${ref}`;
    const huella = huellaDePeticion({ operacion, cuerpo: dto });
    const pendiente: { cancelacion?: CancelacionPendiente } = {};
    const respuesta = await this.idempotencia.ejecutar<{ encontrada: Orden; habitacion: RefHabitacionStock | null }>(clave, operacion, huella, ahora, async (manager, { encontrada, habitacion }) => {
      const solicitadoPor = this.solicitante(dto, principal);
      // La fila de la orden se bloquea: dos cancelaciones simultáneas no devuelven el cupo dos veces
      const orden = await manager.getRepository(Orden).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: encontrada.id }).getOne();
      const totalCentavos = aCentavos(Number(orden.totalPrice));

      if (orden.status === OrdenStatus.CANCELLED) {
        // Ya cancelada: mismo código de reembolso en cada reintento.
        if (!orden.codigoReembolso) {
          const compensada = orden.motivoCancelacion === MOTIVO_SAGA_COMPENSADA;
          Object.assign(orden, {
            codigoReembolso: await this.codigoReembolso(manager),
            ...(compensada ? {} : { refundStatus: 'REFUNDED', porcentajeReembolso: 100, montoReembolsado: totalCentavos / 100 }),
          });
          await manager.save(orden);
        }
        return { status: 200, cuerpo: this.aCancelacion(orden, totalCentavos, true, ahora) };
      }
      // CHECKED_IN / CHECKED_OUT → no se pueden cancelar
      if (orden.status === OrdenStatus.CHECKED_IN || orden.status === OrdenStatus.CHECKED_OUT) {
        throw new ProblemaV2Exception(409, 'INVALID_STATE_TRANSITION', `Una reserva en estado ${orden.status} no se puede cancelar.`);
      }
      // PENDING y CONFIRMED: se cancelan. Para PENDING se libera la retención provisional y se cierra la saga.

      // LiberarCupos: devuelve exactamente lo que esta orden retuvo, una sola vez

      const { porcentaje, estado } = this.reembolso(orden, solicitadoPor, ahora);
      Object.assign(orden, {
        status: OrdenStatus.CANCELLED,
        canceladaEn: ahora,
        solicitadoPor,
        motivoCancelacion: dto.motivo ?? null,
        codigoReembolso: await this.codigoReembolso(manager),
        refundStatus: estado,
        porcentajeReembolso: porcentaje,
        montoReembolsado: divisionHalfUp(totalCentavos * Math.round(porcentaje * 100), 10000) / 100,
      });
      await manager.save(orden);
      await this.eventos.emitirReserva(manager, 'alojamiento.reserva.cancelada', orden, orden.alojamientoCodigo, correlacion);
      // Cupos y aviso quedan pendientes hasta que esta transacción se confirme; la fila de la saga se guarda con la orden
      await this.sagas.registrarCancelacion(manager, orden.id, correlacion);
      pendiente.cancelacion = { ordenId: orden.id, habitacion, fechas: nochesDe(orden.checkin, orden.checkout), correlacion };
      return { status: 200, cuerpo: this.aCancelacion(orden, totalCentavos, false, ahora) };
    }, async () => {
      const encontrada = await this.localizar(ref, principal);
      return { encontrada, habitacion: await this.habitacionParaStock(encontrada.habitacionId) };
    });
    // Una respuesta repetida o una orden que ya estaba cancelada no deja nada pendiente
    if (pendiente.cancelacion && !respuesta.repetida) {
      const liberados = await this.sagas.terminarCancelacion(pendiente.cancelacion);
      if (!liberados) {
        // La liberación real falló (lo termina el barrido): no se afirma lo que no ocurrió, ni en esta respuesta ni en su reintento
        (respuesta.cuerpo as Record<string, unknown>).cuposRestaurados = false;
        await this.dataSource.query(`UPDATE "reservas"."idempotencia_v2" SET "respuesta" = jsonb_set("respuesta"::jsonb, '{cuposRestaurados}', 'false')::json WHERE "clave" = $1`, [clave]);
      }
    }
    return respuesta;
  }

  // Antes de abrir la transacción (fase 8.2): busca la reserva sin bloquearla y comprueba que quien llama puede tocarla
  // (para un administrador eso es leer el catálogo). Dentro, la fila se bloquea por id y se decide con su estado de ese
  // momento: el id, el alojamiento y la habitación de una orden no cambian. También lo usa la estancia.
  async localizar(ref: string, principal: PrincipalV2): Promise<Orden> {
    const encontrada = await this.buscar(this.dataSource.manager, ref);
    await this.exigirAcceso(encontrada, principal);
    return encontrada;
  }

  // La habitación de una orden, para su aviso de stock: del catálogo, antes de abrir la transacción
  async habitacionParaStock(habitacionId: string): Promise<RefHabitacionStock | null> {
    return (await this.catalogo.habitacionesPorIds([habitacionId])).get(habitacionId) ?? null;
  }

  // ───────────────────────── Apoyo ─────────────────────────

  private titular(dto: CrearOrdenV2Dto): Titular {
    const t: Titular | null = dto.huespedTitular
      ? { ...dto.huespedTitular }
      : dto.customer_contact
        ? {
            nombreCompleto: dto.customer_contact.full_name,
            tipoDocumento: dto.customer_contact.document_type,
            identificacion: dto.customer_contact.document_id,
            email: dto.customer_contact.email,
            telefono: dto.customer_contact.phone,
          }
        : null;
    if (!t) {
      throw reglaDeNegocio('VALIDATION_FAILED', 'La reserva necesita los datos del titular (huespedTitular).', [{ name: 'huespedTitular', reason: 'es obligatorio para reservar' }]);
    }
    const motivo = motivoDocumentoInvalido(t.tipoDocumento, t.identificacion);
    if (motivo) {
      throw reglaDeNegocio('INVALID_DOCUMENT', `El documento del titular no es válido: ${motivo}.`, [
        { name: dto.huespedTitular ? 'huespedTitular.identificacion' : 'customer_contact.document_id', reason: motivo },
      ]);
    }
    return t;
  }

  private async cotizacionDe(manager: EntityManager, dto: CrearOrdenV2Dto, alojamientoId: number, habitacionId: string, habitaciones: number, plan: string, o: Ocupacion, ahora: Date) {
    // Sin el manager de reservas: la cotización es de disponibilidad y se lee con su conexión (9.0)
    const cotizacion = await this.disponibilidad.cotizacionPorId(dto.cotizacionId.toLowerCase());
    if (!cotizacion) throw noEncontrado(`No existe la cotización '${dto.cotizacionId}'.`);
    const misma =
      cotizacion.alojamientoId === alojamientoId &&
      cotizacion.habitacionId === habitacionId &&
      cotizacion.fechaInicio === dto.fechaInicio &&
      cotizacion.fechaFin === dto.fechaFin &&
      cotizacion.cantidadHabitaciones === habitaciones &&
      cotizacion.planTarifaCodigo === plan &&
      cotizacion.ocupantes.adultos === o.adultos &&
      cotizacion.ocupantes.ninos === o.ninos;
    if (!misma) {
      throw reglaDeNegocio('VALIDATION_FAILED', 'La cotización es de otra estancia (alojamiento, habitación, fechas, plan u ocupantes distintos).', [
        { name: 'cotizacionId', reason: 'no corresponde a esta reserva' },
      ]);
    }
    if (!estaVigente(cotizacion.validaHasta, ahora)) {
      throw new ProblemaV2Exception(409, 'QUOTE_EXPIRED', `La cotización venció el ${isoGuayaquil(cotizacion.validaHasta)}. Vuelve a cotizar.`);
    }
    return cotizacion;
  }

  // ref = UUID (orderId), ORD-HTL-<localizador> (externalOrderId) o BK-HOTEL-<localizador> (codigoReserva)
  async buscar(manager: EntityManager, ref: string): Promise<Orden> {
    const locator = ref.match(/^(?:ORD-HTL|BK-HOTEL)-([A-Z0-9]{3,20})$/)?.[1];
    const orden = await manager.findOne(Orden, { where: locator ? { locator } : { id: ref.toLowerCase() } });
    if (!orden) throw noEncontrado(`No existe la reserva '${ref}'.`);
    return orden;
  }

  // Autorización por objeto (§7): un CLIENTE solo sus reservas; un administrador, las de sus alojamientos
  async exigirAcceso(orden: Orden, principal: PrincipalV2): Promise<void> {
    if (principal.rol === 'CLIENTE' && orden.clienteId !== principal.usuarioId) {
      throw new ProblemaV2Exception(403, 'FORBIDDEN', 'Esta reserva no es tuya.');
    }
    if (principal.rol === 'ADMIN' && !principal.superadmin) {
      if (principal.alojamientoId != null) {
        if (orden.alojamientoId !== principal.alojamientoId) throw new ProblemaV2Exception(403, 'FORBIDDEN', 'La reserva es de un alojamiento que no administras.');
      } else {
        const propietario = (await this.catalogo.alojamientoPorId(orden.alojamientoId))?.propietarioId;
        if (propietario !== principal.usuarioId) throw new ProblemaV2Exception(403, 'FORBIDDEN', 'La reserva es de un alojamiento que no administras.');
      }
    }
  }

  // Quién cancela: solo un token de servicio (la Saga) puede compensar; un cliente cancela como CLIENTE
  private solicitante(dto: CancelarOrdenV2Dto, principal: PrincipalV2): string {
    const permitidos = { SERVICE: ['SAGA_ORCHESTRATOR', 'HOTEL', 'ADMIN', 'CLIENTE'], ADMIN: ['ADMIN', 'HOTEL'], CLIENTE: ['CLIENTE'] }[principal.rol];
    const pedido = dto.solicitadoPor ?? { SERVICE: 'SAGA_ORCHESTRATOR', ADMIN: 'ADMIN', CLIENTE: 'CLIENTE' }[principal.rol];
    if (!permitidos.includes(pedido)) {
      throw new ProblemaV2Exception(403, 'FORBIDDEN', `Con tus credenciales no puedes cancelar como ${pedido}.`);
    }
    return pedido;
  }

  // Reembolso (§4): la compensación de la Saga devuelve el 100 % siempre; el hotel o un administrador, también;
  // un cliente, según la política del plan (dentro de la ventana 100 %, fuera de ella se aplica la penalidad).
  private reembolso(orden: Orden, solicitadoPor: string, ahora: Date): { porcentaje: number; estado: string } {
    if (solicitadoPor === 'SAGA_ORCHESTRATOR') return { porcentaje: 100, estado: 'COMPENSATED' };
    if (solicitadoPor !== 'CLIENTE') return { porcentaje: 100, estado: 'REFUNDED' };
    const politica = this.politica(orden);
    if (!politica.esReembolsable) return { porcentaje: 0, estado: 'NO_REFUND' };
    if (ahora.getTime() <= this.finVentana(orden, politica).getTime()) return { porcentaje: 100, estado: 'REFUNDED' };
    const porcentaje = 100 - (politica.penalidadFueraDeVentanaPorcentaje ?? 100);
    return { porcentaje, estado: porcentaje > 0 ? 'REFUNDED' : 'NO_REFUND' };
  }

  private politica(orden: Orden): PoliticaCancelacion {
    return (orden.politicaCancelacion as PoliticaCancelacion) ?? politicaDeCancelacion(orden.habitacionCancellationType ?? null);
  }

  // Hasta cuándo se reembolsa el 100 %: la hora de llegada menos la ventana del plan (sin ventana, hasta la llegada)
  private finVentana(orden: Orden, politica: PoliticaCancelacion, horaLlegada = '14:00'): Date {
    return new Date(llegada(orden.checkin, horaLlegada).getTime() - (politica.horasLimiteCancelacion ?? 0) * 3_600_000);
  }

  private async generarLocator(manager: EntityManager): Promise<string> {
    for (let intento = 0; intento < 5; intento++) {
      const locator = Array.from({ length: LARGO_LOCATOR }, () => ALFABETO_LOCATOR[randomInt(ALFABETO_LOCATOR.length)]).join('');
      if (!(await manager.existsBy(Orden, { locator }))) return locator;
    }
    throw new Error('No se pudo generar un localizador único');
  }

  private async codigoReembolso(manager: EntityManager): Promise<string> {
    for (let intento = 0; intento < 5; intento++) {
      const codigo = `REF-HTL-${String(randomInt(10_000_000, 100_000_000))}`;
      if (!(await manager.existsBy(Orden, { codigoReembolso: codigo }))) return codigo;
    }
    throw new Error('No se pudo generar un código de reembolso único');
  }

  // total = subtotal + IVA + tasa − descuentoCombo (contrato §4). El IVA se calcula sobre el subtotal SIN descuento.
  // descuentoMonto debe ser exactamente round_half_up(subtotal × descuentoPorcentaje / 100): si no, 422 VALIDATION_FAILED.
  private conDescuentoDeCombo(d: DesgloseV2, paquete: { descuentoPorcentaje: number; descuentoMonto: string }) {
    const subtotal = moneyACentavos(d.subtotal);
    const esperado = descuentoEnCentavos(subtotal, paquete.descuentoPorcentaje);
    if (moneyACentavos(paquete.descuentoMonto) !== esperado) {
      throw reglaDeNegocio(
        'VALIDATION_FAILED',
        `descuentoMonto (${paquete.descuentoMonto}) debe ser ${centavosAMoney(esperado)}: ${paquete.descuentoPorcentaje} % de ${d.subtotal}.`,
        [{ name: 'paquete.descuentoMonto', reason: `debe ser ${centavosAMoney(esperado)}` }],
      );
    }
    const total = subtotal + moneyACentavos(d.ivaValor) + moneyACentavos(d.tasaMunicipal) - esperado;
    return { ...d, descuentoCombo: centavosAMoney(esperado), totalPagar: centavosAMoney(total) };
  }

  private aDesgloseFiscal(d:DesgloseV2) {
    return {
      subtotal: d.subtotal,
      ivaPorcentaje: d.ivaPorcentaje,
      ivaValor: d.ivaValor,
      iva15Pct: d.iva15Pct,
      tasaMunicipal: d.tasaMunicipal,
      descuentoCombo: d.descuentoCombo,
      total: d.totalPagar,
      impuestos: d.impuestos,
    };
  }

  // OrderDetailV2. Las órdenes hechas por la v1 no tienen desglose ni titular: se muestran sin impuestos (así se vendieron).
  // `conClave`: la credencial de la puerta solo se muestra al huésped y al administrador, nunca en listados ni a un servicio.
  aDetalle(orden: Orden, conClave = false) {
    const total = centavosAMoney(aCentavos(Number(orden.totalPrice)));
    const politica = this.politica(orden);
    // El contrato fija el check-in en las 14:00 de Guayaquil para todos los alojamientos (§4)
    const horaLlegada = HORA_CHECKIN;
    const ninos = Array.isArray(orden.guests?.children) ? (orden.guests.children as number[]) : [];
    const base = `/api/v2/alojamientos/orders/${orden.id}`;
    const historial = [{ estado: 'CONFIRMED', en: new Date(orden.createdAt).toISOString() }];
    if (orden.checkInEn) historial.push({ estado: 'CHECKED_IN', en: new Date(orden.checkInEn).toISOString() });
    if (orden.checkOutEn) historial.push({ estado: 'CHECKED_OUT', en: new Date(orden.checkOutEn).toISOString() });
    if (orden.status === OrdenStatus.CANCELLED) historial.push({ estado: 'CANCELLED', en: new Date(orden.canceladaEn ?? orden.updatedAt).toISOString() });
    const confirmada = orden.status === OrdenStatus.CONFIRMED || orden.status === OrdenStatus.PENDING;
    const regimen = orden.regimen ?? regimenDeMealPlan(orden.habitacionMealPlan);
    return {
      orderId: orden.id,
      external_order_id: `ORD-HTL-${orden.locator}`,
      externalOrderId: `ORD-HTL-${orden.locator}`,
      codigoReserva: `BK-HOTEL-${orden.locator}`,
      estado: orden.status,
      ...(orden.sagaId && { saga_id: orden.sagaId }),
      alojamientoId: orden.alojamientoCodigo,
      alojamientoNombre: orden.alojamientoNombre.slice(0, 150),
      tipoHabitacionCodigo: orden.habitacionCodigo,
      tipoHabitacion: orden.habitacionNombre.slice(0, 100),
      cantidadHabitaciones: orden.habitacionesReservadas,
      ocupantes: { adultos: Number(orden.guests?.number_of_adults ?? 1), ninos: ninos.length, ...(ninos.length > 0 && { edadesNinos: ninos }) },
      ...(regimen && { regimen }),
      checkinFecha: orden.checkin,
      checkoutFecha: orden.checkout,
      noches: calcularNoches(orden.checkin, orden.checkout),
      checkinHabilitadoDesde: isoGuayaquil(
        checkinHabilitadoDesde({ checkinFecha: orden.checkin, checkoutFecha: orden.checkout, earlyAutorizado: !!orden.earlyCheckinAutorizado, earlyDesde: orden.earlyCheckinDesde ? new Date(orden.earlyCheckinDesde) : null }),
      ),
      earlyCheckinAutorizado: !!orden.earlyCheckinAutorizado,
      ...(orden.cotizacionId && { cotizacionId: orden.cotizacionId }),
      ...(orden.huespedTitular && { huespedTitular: orden.huespedTitular }),
      desgloseFiscal: orden.desgloseFiscal ?? {
        subtotal: total,
        ivaPorcentaje: 0,
        ivaValor: '0.00',
        tasaMunicipal: '0.00',
        descuentoCombo: '0.00',
        total,
      },
      total,
      currency: orden.currency,
      politicaCancelacionAplicable: {
        esReembolsable: politica.esReembolsable,
        ...(politica.esReembolsable && { reembolso100HastaFecha: isoGuayaquil(this.finVentana(orden, politica, horaLlegada)) }),
        descripcion: politica.descripcion,
      },
      habitacionAsignada: orden.habitacionAsignada ?? null,
      claveAccesoDigital: conClave ? (orden.claveAccesoDigital ?? null) : null,
      historialEstados: historial,
      createdAt: new Date(orden.createdAt).toISOString(),
      _links: {
        self: { href: base, method: 'GET' },
        ...(confirmada && { cancel: { href: `${base}/cancel`, method: 'POST' }, checkIn: { href: `${base}/check-in`, method: 'POST' } }),
        ...(orden.status === OrdenStatus.CHECKED_IN && { checkOut: { href: `${base}/checkout`, method: 'POST' } }),
        ...(orden.status === OrdenStatus.CHECKED_OUT && { resena: { href: `/api/v2/alojamientos/${orden.alojamientoCodigo}/resenas`, method: 'POST' } }),
      },
      ...(orden.planTarifaCodigo && { planTarifaCodigo: orden.planTarifaCodigo }),
      ...(orden.modeloPago && { modeloPago: orden.modeloPago }),
    };
  }

  // CancelOrderResponseV2
  private aCancelacion(orden: Orden, totalCentavos: number, yaCancelada: boolean, ahora: Date) {
    const reembolsado = aCentavos(Number(orden.montoReembolsado ?? 0));
    return {
      orderId: orden.id,
      external_order_id: `ORD-HTL-${orden.locator}`,
      estado: 'CANCELLED',
      refundStatus: orden.refundStatus,
      codigoReembolso: orden.codigoReembolso,
      porcentajeReembolso: Number(orden.porcentajeReembolso ?? 0),
      montoReembolsado: centavosAMoney(reembolsado),
      // penalidad siempre presente (contrato); 0.00 cuando no aplica (saga compensada o reembolso total)
      penalidad: orden.motivoCancelacion === MOTIVO_SAGA_COMPENSADA ? '0.00' : centavosAMoney(Math.max(0, totalCentavos - reembolsado)),
      cuposRestaurados: true, // se corrige tras terminarCancelacion si la liberación real falló
      yaCancelada,
      timestamp: isoGuayaquil(ahora),
      _links: { orden: { href: `/api/v2/alojamientos/orders/${orden.id}`, method: 'GET' } },
    };
  }
}

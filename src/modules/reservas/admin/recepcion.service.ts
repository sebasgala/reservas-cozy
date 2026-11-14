import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CatalogoPuerto } from '../../catalogo/catalogo.puerto';
import { DisponibilidadPuerto, nochesDe } from '../../disponibilidad/disponibilidad.puerto';
import { ConflictoException, ConsultaInvalidaException, ProhibidoException } from '../../comun/problems/problem-details.exceptions';
import { fechaGuayaquil, isoGuayaquil } from '../../comun/v2/reloj';
import { RolUsuario, UsuarioSesion } from '../../usuarios/usuarios.contrato';
import {
  AprobarCheckinDto,
  AuditoriaRecepcionDto,
  AutorizarEarlyCheckinDto,
  CambiarHuespedesDto,
  CambiarObservacionesDto,
  ContextoRecepcionDto,
  FiltroRecepcionQueryDto,
  HabitacionReasignableDto,
  ReasignarHabitacionDto,
  ReservaRecepcionDto,
  ReservasRecepcionPaginadasDto,
} from '../dto/admin/recepcion.dto';
import { AccionRecepcion, AuditoriaRecepcion } from '../entities/auditoria-recepcion.entity';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { checkinCierraEn, checkinHabilitadoDesde, evaluarVentanaCheckin, mismoDocumento, normalizarDocumento, VentanaCheckin } from '../v2/checkin';
import { BookingCheckinClient } from '../v2/booking-checkin.client';
import { AccesoReservasService } from './acceso-reservas.service';
import { HabitacionesFisicasService } from './habitaciones-fisicas.service';
import { EventosService } from '../../comun/v2/eventos.service';
import { CONEXION } from '../../../database/conexiones';

// Bloque R (R6–R9): mostrador de recepción sobre las reservas de SU alojamiento (el del token).
// Cada cambio deja su fila en reservas.auditoria_recepcion en la misma transacción.

type Cambio = { antes: Record<string, unknown>; despues: Record<string, unknown> } | null;

const enmascarar = (documento: string): string => {
  const d = normalizarDocumento(documento);
  return d.length <= 4 ? '****' : `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
};

@Injectable()
export class RecepcionService {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly acceso: AccesoReservasService,
    private readonly catalogo: CatalogoPuerto,
    private readonly disponibilidad: DisponibilidadPuerto,
    private readonly habitacionesFisicas: HabitacionesFisicasService,
    private readonly eventos: EventosService,
    @Optional() private readonly bookingClient?: BookingCheckinClient,
  ) { }

  async contexto(usuario: UsuarioSesion): Promise<ContextoRecepcionDto> {
    if (usuario.alojamientoId == null) return { alojamientoId: null, alojamientoNombre: null, alojamientoCodigo: null };
    const a = await this.catalogo.alojamientoPorId(usuario.alojamientoId);
    return { alojamientoId: usuario.alojamientoId, alojamientoNombre: a?.nombre ?? null, alojamientoCodigo: a?.codigo ?? null };
  }

  async listar(f: FiltroRecepcionQueryDto, usuario: UsuarioSesion, ahora = new Date()): Promise<ReservasRecepcionPaginadasDto> {
    if (f.llegadaDesde && f.llegadaHasta && f.llegadaDesde > f.llegadaHasta) {
      throw new ConsultaInvalidaException([{ name: 'llegadaHasta', reason: 'no puede ser anterior a llegadaDesde' }]);
    }
    if (f.pendientesCheckin && f.estado && f.estado !== OrdenStatus.CONFIRMED) {
      throw new ConsultaInvalidaException([{ name: 'estado', reason: 'pendientesCheckin solo muestra reservas CONFIRMED' }]);
    }
    const pagina = f.page ?? 1;
    const limite = f.limit ?? 20;
    const consulta = this.dataSource
      .getRepository(Orden)
      .createQueryBuilder('o')
      .skip((pagina - 1) * limite)
      .take(limite);
    // Tablero activo: solo reservas sin archivar (CONFIRMED, CHECKED_IN, POR_LIMPIAR, CANCELLED…). Las LIMPIA_LISTA
    // y las archivadas a mano salen del tablero (salvo que f.archivadaRecepcion pida true).
    const archivada = f.archivadaRecepcion ?? false;
    consulta.andWhere('o.archivadaRecepcion = :archivada', { archivada });
    if (f.pendientesCheckin) {
      consulta
        .andWhere('o.status = :pendiente', { pendiente: OrdenStatus.CONFIRMED })
        .andWhere('o.checkout >= :hoy', { hoy: fechaGuayaquil(ahora) })
        .orderBy('o.checkin', 'ASC')
        .addOrderBy('o.createdAt', 'ASC');
    } else {
      consulta.orderBy('o.createdAt', 'DESC');
    }
    consulta.addOrderBy('o.id', 'ASC');
    const alojamiento = this.acceso.alojamientoDelFiltro(usuario, f.alojamientoId);
    if (alojamiento !== undefined) {
      consulta.andWhere('o.alojamientoId = :alojamiento', { alojamiento });
    } else {
      const propietario = this.acceso.propietarioDelFiltro(usuario);
      if (propietario) {
        const suyos = await this.catalogo.idsDeAlojamientosDe(propietario);
        consulta.andWhere(suyos.length ? 'o.alojamientoId IN (:...suyos)' : '1 = 0', { suyos });
      }
    }
    if (f.estado) consulta.andWhere('o.status = :estado', { estado: f.estado });
    if (f.llegadaDesde) consulta.andWhere('o.checkin >= :desde', { desde: f.llegadaDesde });
    if (f.llegadaHasta) consulta.andWhere('o.checkin <= :hasta', { hasta: f.llegadaHasta });
    const [ordenes, total] = await consulta.getManyAndCount();
    return {
      data: ordenes.map((o) => this.aRecepcion(o)),
      meta: { totalItems: total, itemCount: ordenes.length, itemsPerPage: limite, totalPages: Math.ceil(total / limite), currentPage: pagina },
    };
  }

  async habitacionesReasignables(id: string, usuario: UsuarioSesion): Promise<HabitacionReasignableDto[]> {
    const orden = await this.acceso.orden(id, usuario);
    const disponibles = await this.candidatas(orden);
    const actual = (await this.catalogo.habitaciones({ alojamientoId: orden.alojamientoId, ids: [orden.habitacionId] }))[0];
    const lista: HabitacionReasignableDto[] = disponibles.filter((h) => h.id !== orden.habitacionId).map((h) => ({ ...h, actual: false }));
    if (actual) lista.unshift({ id: actual.id, nombre: actual.nombre, tipo: actual.tipo, actual: true });
    return lista;
  }

  async auditoriaDe(id: string, usuario: UsuarioSesion): Promise<AuditoriaRecepcionDto[]> {
    const orden = await this.acceso.orden(id, usuario);
    const filas = await this.dataSource.getRepository(AuditoriaRecepcion).find({ where: { reservaId: orden.id }, order: { creadoEn: 'DESC' } });
    return filas.map((f) => ({ ...f, creadoEn: new Date(f.creadoEn).toISOString() }));
  }

  async aprobarCheckin(id: string, dto: AprobarCheckinDto, usuario: UsuarioSesion, ahora = new Date()): Promise<ReservaRecepcionDto> {
    let ordenConfirmada: Orden | null = null;
    const resultado = await this.operar(id, usuario, 'CHECKIN_APROBADO', dto.observaciones, async (orden, manager) => {
      if (orden.status !== OrdenStatus.CONFIRMED) {
        throw new ConflictoException('INVALID_STATE_TRANSITION', `No se puede aprobar el check-in de una reserva en estado ${orden.status}`, [{ name: 'id', reason: `estado ${orden.status}` }]);
      }
      const ventana = evaluarVentanaCheckin(this.ventana(orden), ahora);
      if (ventana.estado === 'AUN_NO') {
        throw new ConflictoException('CHECKIN_TIME_NOT_REACHED', `El check-in se habilita el ${isoGuayaquil(ventana.habilitadoDesde)}`, [
          { name: 'id', reason: `habilitado desde ${isoGuayaquil(ventana.habilitadoDesde)}` },
        ]);
      }
      if (ventana.estado === 'VENCIDA') {
        throw new ConflictoException('INVALID_STATE_TRANSITION', `La estancia terminó el ${orden.checkout}`, [{ name: 'id', reason: 'ventana de check-in cerrada' }]);
      }
      const titular = orden.huespedTitular as Record<string, any> | null;
      const docRegistrado = titular?.identificacion ?? titular?.document_id ?? titular?.cedula ?? titular?.numeroIdentificacion ?? null;
      const registrado = docRegistrado != null ? String(docRegistrado).trim() : null;
      if (registrado && !mismoDocumento(dto.documentoPresentado, registrado)) {
        throw new ConsultaInvalidaException([{ name: 'documentoPresentado', reason: 'no coincide con el documento del titular de la reserva' }], 'El documento presentado no coincide con el titular de la reserva');
      }
      const antes = { status: orden.status, checkInEn: orden.checkInEn, habitacionAsignada: orden.habitacionAsignada };
      orden.status = OrdenStatus.CHECKED_IN;
      orden.checkInEn = ahora;
      orden.habitacionAsignada ??= orden.habitacionNombre;
      // Si el alojamiento controla la limpieza: toma una habitación física LIMPIA y la deja OCUPADA (misma transacción y auditoría)
      if (!orden.habitacionFisicaId && (await this.habitacionesFisicas.verificaControlaLimpieza(manager, orden.alojamientoId))) {
        orden.habitacionFisicaId = (await this.habitacionesFisicas.asignarYOcupar(manager, orden.alojamientoId, orden.habitacionId, orden.id, usuario.id)).id;
      }
      if (typeof this.eventos?.emitir === 'function') {
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
          null,
        );
      }
      ordenConfirmada = orden;
      return {
        antes,
        despues: {
          status: orden.status,
          checkInEn: ahora.toISOString(),
          habitacionAsignada: orden.habitacionAsignada,
          habitacionFisicaId: orden.habitacionFisicaId ?? null,
          huespedesPresentes: dto.huespedesPresentes,
          codigoRecepcionista: dto.codigoRecepcionista,
          documentoPresentado: enmascarar(dto.documentoPresentado),
          documentoCoincide: registrado ? true : null,
          documentoVerificadoFisicamente: true,
          observaciones: dto.observaciones?.trim() || null,
        },
      };
    });

    if (ordenConfirmada) {
      await this.notificarCheckinABooking(ordenConfirmada, dto, usuario, ahora);
    }

    return resultado;
  }

  private async notificarCheckinABooking(orden: Orden, dto: AprobarCheckinDto, usuario: UsuarioSesion, ahora: Date): Promise<void> {
    if (!this.bookingClient) return;
    try {
      const payloadBooking = this.bookingClient.construirPayload({
        external_order_id: `ORD-HTL-${orden.locator}`,
        client_id: orden.clienteId ?? orden.id,
        huespedes_reales: dto.huespedesPresentes,
        admin_id: usuario.id ?? 'admin-recepcion',
        fecha_checkin: ahora,
        observaciones: dto.observaciones?.trim() || null,
      });
      const resBooking = await this.bookingClient.notificarCheckin(payloadBooking, null);
      if (!resBooking.omitido) {
        await this.bookingClient.guardarResultado(orden.id, payloadBooking, resBooking, null);
      }
    } catch (err) {
      await this.bookingClient.guardarResultado(
        orden.id,
        null,
        { exito: false, error: (err as Error).message },
        null,
      );
    }
  }

  async reasignarHabitacion(id: string, dto: ReasignarHabitacionDto, usuario: UsuarioSesion): Promise<ReservaRecepcionDto> {
    const encontrada = await this.acceso.orden(id, usuario);
    this.exigirConfirmada(encontrada);
    const candidata = (await this.habitacionesReasignables(id, usuario)).find((h) => h.id === dto.habitacionId);
    if (!candidata) {
      throw new ConflictoException('ROOM_NOT_AVAILABLE', 'La habitación elegida no tiene disponibilidad en las fechas de la reserva', [
        { name: 'habitacionId', reason: 'sin disponibilidad en las fechas de la reserva' },
      ]);
    }
    const nueva = dto.etiqueta?.trim() ? `${candidata.nombre} - ${dto.etiqueta.trim()}` : candidata.nombre;
    return this.operar(id, usuario, 'REASIGNACION_HABITACION', dto.motivo, (orden) => {
      this.exigirConfirmada(orden);
      if (orden.habitacionAsignada === nueva) return null;
      const antes = { habitacionAsignada: orden.habitacionAsignada };
      orden.habitacionAsignada = nueva;
      return { antes, despues: { habitacionAsignada: nueva, habitacionId: candidata.id } };
    });
  }

  async cambiarHuespedes(id: string, dto: CambiarHuespedesDto, usuario: UsuarioSesion): Promise<ReservaRecepcionDto> {
    return this.operar(id, usuario, 'CAMBIO_GUEST_COUNT', dto.motivo, (orden) => {
      this.exigirConfirmada(orden);
      const guests = orden.guests ?? {};
      const antes = { number_of_adults: guests.number_of_adults ?? null, children: guests.children ?? null };
      const despues = { number_of_adults: dto.adultos, children: dto.ninos ?? [] };
      if (antes.number_of_adults === despues.number_of_adults && JSON.stringify(antes.children ?? []) === JSON.stringify(despues.children)) return null;
      orden.guests = { ...guests, ...despues };
      return { antes, despues };
    });
  }

  async cambiarObservaciones(id: string, dto: CambiarObservacionesDto, usuario: UsuarioSesion): Promise<ReservaRecepcionDto> {
    return this.operar(id, usuario, 'CAMBIO_OBSERVACIONES', dto.motivo, (orden) => {
      this.exigirVigente(orden);
      const nuevas = dto.observaciones.trim() || null;
      if ((orden.peticionesEspeciales ?? null) === nuevas) return null;
      const antes = { observaciones: orden.peticionesEspeciales ?? null };
      orden.peticionesEspeciales = nuevas;
      return { antes, despues: { observaciones: nuevas } };
    });
  }

  async autorizarEarlyCheckin(id: string, dto: AutorizarEarlyCheckinDto, usuario: UsuarioSesion, ahora = new Date()): Promise<ReservaRecepcionDto> {
    if (usuario.rol !== RolUsuario.ADMINISTRADOR && usuario.rol !== RolUsuario.SUPERADMIN) {
      throw new ProhibidoException('Solo el administrador del alojamiento autoriza un early check-in');
    }
    const desde = dto.desde ? new Date(dto.desde) : ahora;
    return this.operar(id, usuario, 'EARLY_CHECKIN_AUTORIZADO', dto.motivo, (orden) => {
      if (orden.status !== OrdenStatus.CONFIRMED) {
        throw new ConflictoException('INVALID_STATE_TRANSITION', `No se puede autorizar el early check-in de una reserva en estado ${orden.status}`, [{ name: 'id', reason: `estado ${orden.status}` }]);
      }
      const antes = { autorizado: orden.earlyCheckinAutorizado, desde: orden.earlyCheckinDesde ? new Date(orden.earlyCheckinDesde).toISOString() : null };
      orden.earlyCheckinAutorizado = true;
      orden.earlyCheckinDesde = desde;
      orden.earlyCheckinMotivo = dto.motivo?.trim() || null;
      return { antes, despues: { autorizado: true, desde: desde.toISOString() } };
    });
  }

  // Fase 2: la limpieza terminó. Solo desde POR_LIMPIAR. La reserva pasa a LIMPIA_LISTA y se archiva (sale del tablero),
  // la habitación física vuelve a LIMPIA y se emite el evento interno habitacion.limpia.lista (disponibilidad/ reabre
  // el inventario físico). Todo en la misma transacción y con su fila de auditoría.
  async marcarHabitacionLista(id: string, dto: { habitacionFisicaId?: string; notas?: string }, usuario: UsuarioSesion, ahora = new Date()): Promise<ReservaRecepcionDto> {
    return this.operar(id, usuario, 'HABITACION_LIMPIA_LISTA', dto.notas, async (orden, manager) => {
      if (orden.status !== OrdenStatus.POR_LIMPIAR) {
        throw new ConflictoException('INVALID_STATE_TRANSITION', `La habitación solo se marca limpia desde POR_LIMPIAR (la reserva está ${orden.status})`, [{ name: 'id', reason: `estado ${orden.status}` }]);
      }
      // Un alojamiento sin habitaciones físicas registradas no controla limpieza: el check-in no asigna ninguna y la orden
      // queda sin habitacionFisicaId. No es un error: se cierra igual el ciclo (LIMPIA_LISTA + evento de stock) sin tocar inventario físico.
      const habitacionFisicaId = dto.habitacionFisicaId ?? orden.habitacionFisicaId ?? null;
      const antes = { status: orden.status, archivadaRecepcion: orden.archivadaRecepcion };
      orden.status = OrdenStatus.LIMPIA_LISTA;
      orden.archivadaRecepcion = true;
      // Libera el bloqueo físico (si lo hay): SUCIA/OCUPADA → LIMPIA (deja su historial de limpieza)
      if (habitacionFisicaId) {
        await this.habitacionesFisicas.marcarLista(manager, habitacionFisicaId, orden.id, usuario.id, dto.notas);
      }
      // Evento INTERNO (no va al feed del contrato): disponibilidad/ reabre el inventario físico al recibirlo
      await this.eventos.emitirHabitacionLimpiaLista(manager, `orders/${orden.id}`, orden.alojamientoId, {
        reservaId: orden.id,
        alojamientoId: orden.alojamientoCodigo,
        tipoHabitacionCodigo: orden.habitacionCodigo,
        habitacionFisicaId,
        checkin: orden.checkin,
        checkout: orden.checkout,
        ...(usuario.id && { usuarioId: usuario.id }),
        timestamp: isoGuayaquil(ahora),
      });
      return { antes, despues: { status: orden.status, archivadaRecepcion: true, habitacionFisicaId } };
    });
  }

  // Fase 2: archiva una reserva para sacarla del tablero activo. Solo desde CANCELLED o LIMPIA_LISTA.
  async archivarReservaRecepcion(id: string, usuario: UsuarioSesion, motivo?: string): Promise<ReservaRecepcionDto> {
    return this.operar(id, usuario, 'RESERVA_ARCHIVADA', motivo, (orden) => {
      if (orden.status !== OrdenStatus.CANCELLED && orden.status !== OrdenStatus.LIMPIA_LISTA) {
        throw new ConflictoException('INVALID_STATE_TRANSITION', `Solo se archivan reservas CANCELLED o LIMPIA_LISTA (la reserva está ${orden.status})`, [{ name: 'id', reason: `estado ${orden.status}` }]);
      }
      if (orden.archivadaRecepcion) return null;
      const antes = { archivadaRecepcion: orden.archivadaRecepcion };
      orden.archivadaRecepcion = true;
      return { antes, despues: { archivadaRecepcion: true } };
    });
  }

  private async operar(id: string, usuario: UsuarioSesion, accion: AccionRecepcion, motivo: string | undefined, cambiar: (orden: Orden, manager: EntityManager) => Cambio | Promise<Cambio>): Promise<ReservaRecepcionDto> {
    const encontrada = await this.acceso.orden(id, usuario);
    const orden = await this.dataSource.transaction(async (manager: EntityManager) => {
      const bloqueada = await manager.getRepository(Orden).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: encontrada.id }).getOne();
      const cambio = await cambiar(bloqueada, manager);
      if (!cambio) return bloqueada;
      await manager.save(bloqueada);
      await manager.insert(AuditoriaRecepcion, {
        alojamientoId: bloqueada.alojamientoId,
        reservaId: bloqueada.id,
        usuarioId: usuario.id,
        rol: usuario.rol,
        accion,
        motivo: motivo?.trim() || null,
        datosPrevios: cambio.antes,
        datosNuevos: cambio.despues,
      });
      return bloqueada;
    });
    return this.aRecepcion(orden);
  }

  private async candidatas(orden: Orden): Promise<{ id: string; nombre: string; tipo: string }[]> {
    const habitaciones = Math.max(1, orden.habitacionesReservadas ?? 1);
    const adultos = Number(orden.guests?.number_of_adults ?? 1);
    const ninos = Array.isArray(orden.guests?.children) ? orden.guests.children.length : 0;
    const noches = nochesDe(orden.checkin, orden.checkout).length;
    const disponibles = await this.disponibilidad.habitacionesDisponibles({
      alojamientoId: orden.alojamientoId,
      checkin: orden.checkin,
      checkout: orden.checkout,
      noches,
      reparto: { habitaciones, adultosPorHabitacion: Math.ceil(adultos / habitaciones), ninosPorHabitacion: Math.ceil(ninos / habitaciones) },
    });
    return disponibles.map((h) => ({ id: h.id, nombre: h.nombre, tipo: h.tipo }));
  }

  private ventana(orden: Orden): VentanaCheckin {
    return {
      checkinFecha: orden.checkin,
      checkoutFecha: orden.checkout,
      earlyAutorizado: orden.earlyCheckinAutorizado ?? false,
      earlyDesde: orden.earlyCheckinDesde ? new Date(orden.earlyCheckinDesde) : null,
    };
  }

  // Huéspedes y habitación física solo se editan mientras la orden está CONFIRMED (CHECKED_IN, CHECKED_OUT y CANCELLED → 409)
  private exigirConfirmada(orden: Orden): void {
    if (orden.status !== OrdenStatus.CONFIRMED) {
      throw new ConflictoException('INVALID_STATE_TRANSITION', `La reserva está ${orden.status}: solo se editan huéspedes o habitación en CONFIRMED`, [{ name: 'id', reason: `estado ${orden.status}` }]);
    }
  }

  private exigirVigente(orden: Orden): void {
    if (orden.status !== OrdenStatus.CONFIRMED && orden.status !== OrdenStatus.CHECKED_IN) {
      throw new ConflictoException('INVALID_STATE_TRANSITION', `La reserva está ${orden.status}: no admite cambios de recepción`, [{ name: 'id', reason: `estado ${orden.status}` }]);
    }
  }

  aRecepcion(o: Orden): ReservaRecepcionDto {
    const titular = (o.huespedTitular ?? null) as { nombreCompleto?: string; email?: string; tipoDocumento?: string; identificacion?: string } | null;
    const ventana = this.ventana(o);
    return {
      orderId: o.id,
      locator: o.locator,
      codigoReserva: `BK-HOTEL-${o.locator}`,
      estado: o.status,
      alojamientoId: o.alojamientoId,
      alojamientoNombre: o.alojamientoNombre,
      habitacionId: o.habitacionId,
      habitacionNombre: o.habitacionNombre,
      habitacionAsignada: o.habitacionAsignada ?? null,
      llegada: o.checkin,
      salida: o.checkout,
      noches: nochesDe(o.checkin, o.checkout).length,
      habitaciones: o.habitacionesReservadas,
      titular: {
        nombre: titular?.nombreCompleto ?? `${o.customerFirstName ?? ''} ${o.customerLastName ?? ''}`.trim(),
        email: titular?.email ?? o.customerEmail,
        tipoDocumento: titular?.tipoDocumento ?? null,
        identificacion: titular?.identificacion ?? null,
        documentoRegistrado: Boolean(titular?.identificacion),
      },
      huespedes: {
        adultos: Number(o.guests?.number_of_adults ?? 1),
        ninos: Array.isArray(o.guests?.children) ? (o.guests.children as number[]) : [],
      },
      observaciones: o.peticionesEspeciales ?? null,
      earlyCheckin: { autorizado: o.earlyCheckinAutorizado ?? false, desde: o.earlyCheckinDesde ? new Date(o.earlyCheckinDesde).toISOString() : null },
      checkinHabilitadoDesde: checkinHabilitadoDesde(ventana).toISOString(),
      checkinCierraEn: checkinCierraEn(o.checkout).toISOString(),
      checkInEn: o.checkInEn ? new Date(o.checkInEn).toISOString() : null,
      archivadaRecepcion: o.archivadaRecepcion ?? false,
    };
  }
}

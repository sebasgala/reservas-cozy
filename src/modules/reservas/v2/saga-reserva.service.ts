import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Not } from 'typeorm';
import { CatalogoPuerto, RefHabitacionStock } from '../../catalogo/catalogo.puerto';
import { EventosService } from '../../comun/v2/eventos.service';
import { DisponibilidadPuerto, MotivoStock, nochesDe } from '../../disponibilidad/disponibilidad.puerto';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { EstadoSaga, OperacionSaga, SagaReserva } from '../entities/saga-reserva.entity';
import { DetalleSaga, mensajeDe, SIN_RETORNO } from './saga-reserva';
import { CONEXION } from '../../../database/conexiones';

// Estado de la saga de reserva en la base (fase 8.4) y barrido de las que quedaron colgadas.
//   tomar         la saga de una compra (operación + Idempotency-Key); si la anterior se compensó, empieza otra con otra orden
//   anotar        el estado al que llegó (en la transacción que se le pase, si el paso es de reservas)
//   compensarOrden  una orden PENDING de una saga que no llegó a confirmar: CANCELLED, refundStatus COMPENSATED, sin evento
//   completarAdelante  una orden PENDING cuya retención ya se confirmó: CONFIRMED y su evento
//   avisarReserva  el aviso de stock a Booking, SOLO después de que la transacción de la orden se confirmó (8.4): si esa
//                  transacción falla no queda ningún aviso, y si el aviso falla la orden ya confirmada no se toca
// El barrido (cada minuto) toma las sagas sin terminar que llevan más de 5 minutos quietas: si ya confirmaron la retención
// las termina hacia adelante (orden CONFIRMED, evento y aviso de stock); si no, las compensa. A los 5 intentos fallidos la
// deja FALLIDA. Una saga está CONFIRMADA cuando su orden está confirmada Y el aviso de stock ya se encoló.

export const QUIETA_MS = 5 * 60_000;

// Lo que una cancelación deja para DESPUÉS de confirmar la transacción de la orden (8.5): devolver los cupos y avisar el stock
export interface CancelacionPendiente {
  ordenId: string;
  habitacion: RefHabitacionStock | null;
  fechas: string[];
  correlacion: string | null;
}

// Aviso de stock que un flujo deja para DESPUÉS de confirmar la transacción de la orden (check-out)
export interface AvisoStock {
  habitacion: RefHabitacionStock | null;
  fechas: string[];
  motivo: MotivoStock;
  ordenId: string | null;
  correlacion: string | null;
}
// Marca de una orden compensada por la saga interna (refundStatus COMPENSATED, reembolso 0). COMPENSATED solo ya lo usa la
// cancelación del orquestador del ESB (SAGA_ORCHESTRATOR, reembolso 100 %): esta marca las distingue.
export const MOTIVO_SAGA_COMPENSADA = 'saga compensada';
const INTERVALO_MS = 60_000;
const POR_VUELTA = 20;
const MAX_INTENTOS = 5;
const TERMINADAS: EstadoSaga[] = ['CONFIRMADA', 'COMPENSADA', 'FALLIDA'];

@Injectable()
export class SagaReservaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SagaReserva');
  private temporizador: NodeJS.Timeout | null = null;
  private activo: Promise<number> | null = null;

  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly disponibilidad: DisponibilidadPuerto,
    private readonly eventos: EventosService,
    private readonly catalogo: CatalogoPuerto,
  ) {}

  onModuleInit(): void {
    this.temporizador = setInterval(() => {
      if (this.activo) return;
      this.activo = this.barrer(new Date())
        .catch((e) => {
          this.log.error(`Barrido de sagas con error: ${(e as Error).message}`);
          return 0;
        })
        .finally(() => (this.activo = null));
    }, INTERVALO_MS);
    this.temporizador.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    await this.activo;
  }

  async tomar(operacion: OperacionSaga, clave: string, datos: Record<string, unknown> | null): Promise<SagaReserva> {
    return this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(SagaReserva)
        .values({ ordenId: randomUUID(), operacion, claveIdempotencia: clave, estado: 'INICIADA', datos })
        .orIgnore()
        .execute();
      const saga = await manager
        .getRepository(SagaReserva)
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.operacion = :operacion AND s.claveIdempotencia = :clave', { operacion, clave })
        .getOneOrFail();
      if (saga.estado === 'COMPENSADA') Object.assign(saga, { ordenId: randomUUID(), estado: 'INICIADA', pasoFallido: null, error: null, intentos: 0 });
      if (datos) saga.datos = datos;
      saga.actualizadaEn = new Date();
      return manager.save(saga);
    });
  }

  async anotar(id: string, estado: EstadoSaga, detalle?: DetalleSaga, manager: EntityManager = this.dataSource.manager): Promise<void> {
    await manager.update(SagaReserva, { id }, {
      estado,
      ...(detalle ? { pasoFallido: detalle.pasoFallido ?? null, error: detalle.error ?? null } : {}),
      actualizadaEn: new Date(),
    });
  }

  orden(ordenId: string): Promise<Orden | null> {
    return this.dataSource.getRepository(Orden).findOneBy({ id: ordenId });
  }

  // La orden de una saga compensada: queda CANCELLED con refundStatus COMPENSATED (ya están en el contrato v2), sin
  // reembolso (Cozy nunca la confirmó) y sin evento (nunca se publicó como confirmada). Suelta su preview (v1).
  async compensarOrden(ordenId: string, manager?: EntityManager): Promise<void> {
    const hacer = async (m: EntityManager) => {
      const orden = await this.bloquear(m, ordenId);
      if (!orden || orden.status !== OrdenStatus.PENDING) return;
      Object.assign(orden, {
        status: OrdenStatus.CANCELLED,
        canceladaEn: new Date(),
        motivoCancelacion: MOTIVO_SAGA_COMPENSADA,
        refundStatus: 'COMPENSATED',
        porcentajeReembolso: 0,
        montoReembolsado: 0,
        previewId: null,
      });
      await m.save(orden);
    };
    if (manager) return hacer(manager);
    return this.dataSource.transaction(hacer);
  }

  // PENDING → CONFIRMED y el evento de la reserva, en la transacción de quien llama. Si ya está CONFIRMED no hace nada.
  async completarAdelante(manager: EntityManager, orden: Orden, correlacion: string | null): Promise<void> {
    if (orden.status === OrdenStatus.CONFIRMED) return;
    if (orden.status !== OrdenStatus.PENDING) throw new Error(`La orden ${orden.id} está ${orden.status}: no se puede confirmar`);
    orden.status = OrdenStatus.CONFIRMED;
    await manager.save(orden);
    await this.eventos.emitirReserva(manager, 'alojamiento.reserva.confirmada', orden, orden.alojamientoCodigo, correlacion);
  }

  // Aviso de stock de una reserva confirmada. Se llama cuando la transacción de la orden YA se confirmó; no lanza: si falla,
  // la saga queda en RETENCION_CONFIRMADA con la orden CONFIRMED y el barrido vuelve a avisar (el aviso es el stock actual de
  // las noches, así que repetirlo es inofensivo). Devuelve si quedó avisado.
  async avisarReserva(sagaId: string, ordenId: string, habitacion: RefHabitacionStock | null, fechas: string[], correlacion: string | null): Promise<boolean> {
    try {
      await this.avisar(sagaId, ordenId, habitacion, fechas, correlacion);
      return true;
    } catch (error) {
      this.log.error(`Aviso de stock de la orden ${ordenId} pendiente: ${mensajeDe(error)} (lo reintenta el barrido)`);
      return false;
    }
  }

  // Cancelación (8.5). Dentro de la transacción de la cancelación se deja una fila «cancelarOrden» (INICIADA) junto a la orden
  // CANCELLED. Los cupos NO se devuelven en esa transacción: si falla, no se libera nada y no hay sobreventa. Cuando se confirma, la
  // petición llama a terminarCancelacion; si el proceso cae antes, el barrido la termina. Lo peor que puede pasar es tener cupos
  // retenidos de más un rato (se vende de menos), nunca de menos (no se vende de más).
  async registrarCancelacion(manager: EntityManager, ordenId: string, correlacion: string | null): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(SagaReserva)
      .values({ ordenId, operacion: 'cancelarOrden', claveIdempotencia: ordenId, estado: 'INICIADA', datos: { correlacion } })
      .orIgnore()
      .execute();
  }

  // Con la cancelación ya confirmada: devuelve los cupos, avisa el stock (ya con los cupos devueltos) y cierra la fila. No lanza: la
  // orden ya está cancelada y se responde igual; si algo falla, el barrido lo termina. Devuelve si quedó hecho.
  async terminarCancelacion(c: CancelacionPendiente): Promise<boolean> {
    try {
      await this.liberarYAvisar(c.ordenId, c.habitacion, c.fechas, c.correlacion);
      await this.dataSource.getRepository(SagaReserva).update({ operacion: 'cancelarOrden', claveIdempotencia: c.ordenId }, { estado: 'CONFIRMADA', actualizadaEn: new Date() });
      return true;
    } catch (error) {
      this.log.error(`Cancelación de la orden ${c.ordenId}: faltan cupos o aviso de stock (${mensajeDe(error)}); lo termina el barrido`);
      return false;
    }
  }

  // Idempotente: liberar da YA_LIBERADA si ya estaba, y el aviso es el stock actual de las noches
  private async liberarYAvisar(ordenId: string, habitacion: RefHabitacionStock | null, fechas: string[], correlacion: string | null): Promise<void> {
    if ((await this.disponibilidad.liberarCupos(ordenId)) === 'SIN_RETENCION') throw new Error(`La orden ${ordenId} no tiene retención de cupos`);
    await this.disponibilidad.avisarStock(habitacion, fechas, 'CANCELACION', ordenId, correlacion);
  }

  // Aviso de stock de un check-out (8.5): se pide cuando la transacción de la orden YA se confirmó, igual que el de
  // una compra. No lanza: la orden ya cambió y se responde igual. Si el aviso no sale, Booking se queda con el stock de antes (menos
  // del real tras una cancelación: el lado seguro, no sobrevende) hasta el siguiente aviso de esas noches. Devuelve si salió.
  async avisarStockTrasCommit(aviso: AvisoStock): Promise<boolean> {
    try {
      await this.disponibilidad.avisarStock(aviso.habitacion, aviso.fechas, aviso.motivo, aviso.ordenId, aviso.correlacion);
      return true;
    } catch (error) {
      this.log.error(`Aviso de stock (${aviso.motivo}) de la orden ${aviso.ordenId} no salió: ${mensajeDe(error)}`);
      return false;
    }
  }

  private async avisar(sagaId: string, ordenId: string, habitacion: RefHabitacionStock | null, fechas: string[], correlacion: string | null): Promise<void> {
    await this.disponibilidad.avisarStock(habitacion, fechas, 'RESERVA', ordenId, correlacion);
    await this.anotar(sagaId, 'CONFIRMADA');
  }

  bloquear(manager: EntityManager, ordenId: string): Promise<Orden | null> {
    return manager.getRepository(Orden).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: ordenId }).getOne();
  }

  // Compensación de una compra v1 que no terminó (la orden v1 nunca queda PENDING: se guarda CONFIRMED en la misma
  // transacción que su clave de idempotencia). Si la saga no llegó a CONFIRMADA, se devuelven sus cupos.
  async compensarV1(clave: string, error: unknown): Promise<void> {
    const saga = await this.dataSource.getRepository(SagaReserva).findOneBy({ operacion: 'crearOrdenV1', claveIdempotencia: clave });
    if (!saga || TERMINADAS.includes(saga.estado)) return;
    const detalle = { pasoFallido: 'crearOrdenV1', error: mensajeDe(error) };
    await this.anotar(saga.id, 'COMPENSANDO', detalle);
    await this.disponibilidad.liberarCupos(saga.ordenId);
    await this.anotar(saga.id, 'COMPENSADA', detalle);
  }

  // Devuelve cuántas sagas cerró
  async barrer(ahora: Date): Promise<number> {
    const quietas = await this.dataSource.getRepository(SagaReserva).find({
      select: { id: true },
      where: { estado: Not(In(TERMINADAS)), actualizadaEn: LessThan(new Date(ahora.getTime() - QUIETA_MS)) },
      order: { actualizadaEn: 'ASC' },
      take: POR_VUELTA,
    });
    let cerradas = 0;
    for (const { id } of quietas) {
      try {
        if (await this.cerrar(id, ahora)) cerradas++;
      } catch (error) {
        const saga = await this.dataSource.getRepository(SagaReserva).findOneBy({ id });
        if (!saga) continue;
        const intentos = saga.intentos + 1;
        await this.dataSource.getRepository(SagaReserva).update({ id }, {
          intentos,
          error: mensajeDe(error),
          ...(intentos >= MAX_INTENTOS ? { estado: 'FALLIDA' as EstadoSaga } : {}),
          actualizadaEn: new Date(),
        });
        this.log.error(`Saga ${id} (intento ${intentos}): ${mensajeDe(error)}`);
      }
    }
    if (cerradas > 0) this.log.log(`Sagas colgadas cerradas: ${cerradas}`);
    return cerradas;
  }

  // Cierra una saga quieta con su fila bloqueada (SKIP LOCKED: si una petición la está retomando, la deja). Lo de reservas
  // (orden y evento) va en una transacción; el aviso de stock a Booking, solo después de que esa transacción se confirme.
  private async cerrar(id: string, ahora: Date): Promise<boolean> {
    const resultado = await this.dataSource.transaction(async (manager): Promise<boolean | AvisoPendiente> => {
      const saga = await manager
        .getRepository(SagaReserva)
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('s.id = :id', { id })
        .getOne();
      if (!saga || TERMINADAS.includes(saga.estado) || saga.actualizadaEn.getTime() >= ahora.getTime() - QUIETA_MS) return false;
      const orden = await this.bloquear(manager, saga.ordenId);
      const correlacion = (saga.datos?.correlacion as string | null) ?? null;
      if (saga.operacion === 'cancelarOrden') {
        // Cancelación (8.5): la orden se canceló en su transacción; faltan los cupos y el aviso, que van tras este commit
        if (orden?.status !== OrdenStatus.CANCELLED) throw new Error(`La orden ${saga.ordenId} de la cancelación ${id} no está cancelada: no se devuelven sus cupos`);
        return { sagaId: id, orden, correlacion, cancelacion: true };
      }
      // Orden ya confirmada (la guardó una petición, o la v1 en su transacción): solo falta el aviso de stock, tras el commit
      if (orden?.status === OrdenStatus.CONFIRMED) return { sagaId: id, orden, correlacion };
      if (SIN_RETORNO.includes(saga.estado)) {
        // La retención ya es definitiva: se termina hacia adelante (orden CONFIRMED y evento aquí; el aviso, tras el commit)
        if (!orden) throw new Error(`La saga ${id} confirmó la retención pero no tiene orden`);
        if (orden.status !== OrdenStatus.PENDING) {
          // Cancelada por su dueño antes de que se avisara el stock: la cancelación ya avisó; no hay nada que confirmar ni avisar
          await this.anotar(id, 'CONFIRMADA', undefined, manager);
          return true;
        }
        await this.completarAdelante(manager, orden, correlacion);
        return { sagaId: id, orden, correlacion };
      }
      // Antes del punto sin retorno: se compensa (orden y cupos)
      await this.compensarOrden(saga.ordenId, manager);
      await this.disponibilidad.liberarCupos(saga.ordenId);
      await this.anotar(id, 'COMPENSADA', { pasoFallido: saga.pasoFallido ?? saga.estado, error: saga.error ?? 'saga colgada: la cerró el barrido' }, manager);
      return true;
    });
    if (typeof resultado === 'boolean') return resultado;

    // Ya confirmada la transacción de reservas: ahora sí, el aviso de stock. Si falla, cuenta como un intento del barrido.
    const { orden, sagaId, correlacion } = resultado;
    const habitacion = (await this.catalogo.habitacionesPorIds([orden.habitacionId])).get(orden.habitacionId) ?? null;
    if (resultado.cancelacion) {
      await this.liberarYAvisar(orden.id, habitacion, nochesDe(orden.checkin, orden.checkout), correlacion);
      await this.anotar(sagaId, 'CONFIRMADA');
      return true;
    }
    await this.avisar(sagaId, orden.id, habitacion, nochesDe(orden.checkin, orden.checkout), correlacion);
    return true;
  }
}

// Lo que `cerrar` deja para después de confirmar su transacción
interface AvisoPendiente {
  sagaId: string;
  orden: Orden;
  correlacion: string | null;
  // true: es una cancelación (devolver cupos y avisar), no una compra (solo avisar)
  cancelacion?: boolean;
}

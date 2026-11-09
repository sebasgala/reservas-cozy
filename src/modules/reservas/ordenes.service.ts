import { randomInt, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { AlojamientoCatalogo, CatalogoPuerto, HabitacionCatalogo, RefHabitacionStock } from '../catalogo/catalogo.puerto';
import { DisponibilidadPuerto, nochesDe } from '../disponibilidad/disponibilidad.puerto';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { Orden, OrdenStatus, UQ_ORDENES_LOCATOR, UQ_ORDENES_PREVIEW } from './entities/orden.entity';
import { OrdenPreview } from './entities/orden-preview.entity';
import { OrderPreviewRequestDto, OrderPreviewResponseDto } from './dto/order-preview.dto';
import { OrderCreateRequestDto } from './dto/order-create.dto';
import { OrderDetailDto } from './dto/order-detail.dto';
import { EventosService } from '../comun/v2/eventos.service';
import { AuditoriaService } from '../comun/auditoria.service';
import { CancelacionPendiente, SagaReservaService } from './v2/saga-reserva.service';
import {
  ClaveIdempotenciaReutilizadaException,
  ConflictoException,
  ConsultaInvalidaException,
  RecursoNoEncontradoException,
} from '../comun/problems/problem-details.exceptions';
import { calcularNoches, esUuid, exigirFechaNoPasada, huellaDePeticion, interpretarProductId, precioOrden, repartirHuespedes } from '../comun/alojamientos-consulta.utils';
import { CONEXION } from '../../database/conexiones';

// El contrato no dice cuánto dura una vista previa: 15 minutos.
const MINUTOS_VIGENCIA_PREVIEW = 15;
const ENDPOINT_CREATE = 'POST /orders/create';
// Localizador legible: sin 0/O ni 1/I para que no se confundan al dictarlo.
const ALFABETO_LOCATOR = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_LOCATOR = 8;

// Lo que la creación necesita del catálogo, leído antes de abrir la transacción con los ids del preview (fase 8.2)
interface CatalogoDelPreview {
  previewId: string;
  alojamiento: AlojamientoCatalogo | null;
  habitacion: HabitacionCatalogo | null;
}

export interface RespuestaCreacion {
  statusCode: number;
  body: OrderDetailDto;
}

// Lo que la transacción de la orden deja para DESPUÉS de confirmarse (8.4): el aviso de stock a Booking
interface AvisoDeStock {
  sagaId: string;
  ordenId: string;
  habitacion: RefHabitacionStock | null;
  fechas: string[];
}

interface CreacionEnTransaccion {
  respuesta: RespuestaCreacion;
  aviso: AvisoDeStock | null;
}

@Injectable()
export class OrdenesService {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    @InjectRepository(OrdenPreview, CONEXION.reservas)
    private readonly previewsRepository: Repository<OrdenPreview>,
    @InjectRepository(Orden, CONEXION.reservas)
    private readonly ordenesRepository: Repository<Orden>,
    @InjectRepository(IdempotencyKey, CONEXION.reservas)
    private readonly clavesRepository: Repository<IdempotencyKey>,
    private readonly disponibilidad: DisponibilidadPuerto,
    private readonly catalogo: CatalogoPuerto,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosService,
    private readonly sagas: SagaReservaService,
  ) {}

  // ───────────────────────── POST /orders/preview ─────────────────────────

  // Comprueba disponibilidad y calcula el precio con la función compartida. No descuenta cupos.
  async preview(request: OrderPreviewRequestDto): Promise<OrderPreviewResponseDto> {
    // El product_id ya trae la habitación y las fechas (formato <uuid>:<checkin>:<checkout>).
    const oferta = interpretarProductId(request.product_id);
    const noches = calcularNoches(oferta.checkin, oferta.checkout);
    exigirFechaNoPasada(oferta.checkin, 'product_id', 'El checkin del product_id');
    const reparto = repartirHuespedes(request.guests);
    const alojamiento = await this.catalogo.alojamientoActivoPorId(request.accommodation_id);
    if (!alojamiento) {
      const reason = `El alojamiento ${request.accommodation_id} no existe o está inactivo`;
      throw new RecursoNoEncontradoException(reason, [{ name: 'accommodation_id', reason }]);
    }

    const [habitacion] = await this.catalogo.habitaciones({ ids: [oferta.habitacionId], alojamientoId: alojamiento.id, soloActivas: true });
    if (!habitacion) {
      const reason = `La habitación ${oferta.habitacionId} no existe en el alojamiento ${alojamiento.id}`;
      throw new RecursoNoEncontradoException(reason, [{ name: 'product_id', reason }]);
    }
    if (habitacion.capacidadAdultos < reparto.adultosPorHabitacion || habitacion.capacidadNinos < reparto.ninosPorHabitacion) {
      throw new ConsultaInvalidaException([
        {
          name: 'guests',
          reason: `No caben en la habitación: máximo ${habitacion.capacidadAdultos} adultos y ${habitacion.capacidadNinos} niños por habitación`,
        },
      ]);
    }

    const [disponible] = await this.disponibilidad.habitacionesDisponibles({
      alojamientoId: alojamiento.id,
      habitacionId: habitacion.id,
      checkin: oferta.checkin,
      checkout: oferta.checkout,
      noches,
      reparto,
    });
    if (!disponible) {
      throw new ConflictoException('ROOM_NO_LONGER_AVAILABLE', 'La habitación no tiene cupos suficientes en todas las noches pedidas', [
        { name: 'product_id', reason: 'Sin cupos suficientes para esas fechas' },
      ]);
    }

    const preview = await this.previewsRepository.save(
      this.previewsRepository.create({
        alojamientoId: alojamiento.id,
        habitacionId: habitacion.id,
        guests: { ...request.guests },
        checkin: oferta.checkin,
        checkout: oferta.checkout,
        totalPrice: precioOrden(disponible.total, reparto.habitaciones),
        currency: alojamiento.moneda,
        expiresAt: new Date(Date.now() + MINUTOS_VIGENCIA_PREVIEW * 60 * 1000),
      }),
    );

    return {
      request_id: randomUUID(),
      data: { order_preview_id: preview.id, total_price: preview.totalPrice, currency: preview.currency },
    };
  }

  // ───────────────────────── POST /orders/create ─────────────────────────

  // Idempotencia: misma clave + mismo cuerpo => la respuesta guardada (sin crear otra orden);
  // misma clave + cuerpo distinto => 422. Solo se guardan las creaciones exitosas.
  // Un preview da una sola orden: otra clave sobre un preview ya usado => 409.
  // clienteId: el usuario del token si la petición lo trae; null = compra sin cuenta.
  async crear(idempotencyKey: string, request: OrderCreateRequestDto, clienteId: string | null = null): Promise<RespuestaCreacion> {
    const huella = huellaDePeticion(request);
    const guardada = await this.clavesRepository.findOneBy({ key: idempotencyKey });
    if (guardada) return this.repetirRespuesta(guardada, huella);

    // Fase 8.2: el catálogo se lee aquí, antes de abrir la transacción; dentro se decide con lo leído, en el mismo
    // punto y con el mismo error que antes (una repetición ya respondió arriba sin leerlo).
    const catalogo = await this.catalogoDelPreview(request.order_preview_id);
    for (let intento = 1; ; intento++) {
      let creada: CreacionEnTransaccion;
      try {
        creada = await this.dataSource.transaction((manager) => this.crearEnTransaccion(manager, idempotencyKey, huella, request, clienteId, catalogo));
      } catch (error) {
        // Saga de 8.4: la transacción de la orden se deshizo; los cupos retenidos (en la de disponibilidad) se devuelven
        await this.sagas.compensarV1(idempotencyKey, error);
        const violacion = this.violacionUnica(error);
        // Otra petición con la misma clave terminó primero: se responde lo que ella guardó.
        if (violacion?.table === 'idempotency_keys') {
          const ganadora = await this.clavesRepository.findOneBy({ key: idempotencyKey });
          if (ganadora) return this.repetirRespuesta(ganadora, huella);
        }
        // Respaldo del bloqueo del preview: el índice único también impide dos órdenes por preview.
        if (violacion?.constraint === UQ_ORDENES_PREVIEW) throw this.previewYaUsado();
        // Colisión de localizador (casi imposible): se repite la transacción entera.
        if (violacion?.constraint === UQ_ORDENES_LOCATOR && intento < 3) continue;
        throw error;
      }
      // La transacción de la orden ya se confirmó: recién ahora Booking recibe el aviso de stock (8.4). Si el aviso falla, la
      // orden se responde igual y el barrido de sagas lo reintenta.
      const { respuesta, aviso } = creada;
      if (aviso) await this.sagas.avisarReserva(aviso.sagaId, aviso.ordenId, aviso.habitacion, aviso.fechas, null);
      return respuesta;
    }
  }

  // Saga de 8.4 (v1): la orden y su clave van en esta transacción; los cupos se retienen y se confirman en la de
  // disponibilidad. Si algo falla, PostgreSQL deshace la orden y la clave, y `crear` devuelve los cupos (compensarV1).
  // La orden v1 nace CONFIRMED (no pasa por PENDING): el preview queda bloqueado hasta el final y su respuesta solo
  // se guarda si todo salió bien. La retención se confirma justo antes de confirmar esta transacción, SIN aviso de stock:
  // el aviso a Booking lo pide `crear` cuando la transacción ya se confirmó (devuelve `aviso`).
  private async crearEnTransaccion(
    manager: EntityManager,
    idempotencyKey: string,
    huella: string,
    request: OrderCreateRequestDto,
    clienteId: string | null,
    catalogo: CatalogoDelPreview | null,
  ): Promise<CreacionEnTransaccion> {
    // 1. Bloqueo del preview: dos creaciones sobre el mismo preview pasan de a una.
    const preview = esUuid(request.order_preview_id)
      ? await manager
          .getRepository(OrdenPreview)
          .createQueryBuilder('p')
          .setLock('pessimistic_write')
          .where('p.id = :id', { id: request.order_preview_id })
          .getOne()
      : null;
    if (!preview) {
      throw new ConsultaInvalidaException([{ name: 'order_preview_id', reason: 'La vista previa no existe' }]);
    }
    // 2. Si mientras esperábamos el bloqueo terminó otra petición con la MISMA clave, se repite su respuesta.
    const ganadora = await manager.findOneBy(IdempotencyKey, { key: idempotencyKey });
    if (ganadora) return { respuesta: this.repetirRespuesta(ganadora, huella), aviso: null };
    // 3. Con OTRA clave, un preview ya usado es un conflicto: no se crea una segunda orden.
    if (await manager.existsBy(Orden, { previewId: preview.id })) throw this.previewYaUsado();

    if (preview.expiresAt.getTime() <= Date.now()) {
      throw new ConsultaInvalidaException([
        { name: 'order_preview_id', reason: 'La vista previa expiró: pide una nueva con /orders/preview' },
      ]);
    }

    // La vista previa pudo crearse ayer para una entrada que hoy ya pasó.
    exigirFechaNoPasada(preview.checkin, 'order_preview_id', 'El checkin de la vista previa');

    // El alojamiento y la habitación se leyeron antes de la transacción con los ids de este mismo preview (no cambian)
    if (catalogo?.previewId !== preview.id) throw new Error(`El catálogo del preview ${preview.id} no se leyó antes de la transacción`);
    const { alojamiento, habitacion } = catalogo;
    if (!alojamiento) {
      throw new ConflictoException('ROOM_NO_LONGER_AVAILABLE', 'El alojamiento ya no está disponible');
    }

    const reparto = repartirHuespedes(preview.guests as { number_of_adults: number; number_of_rooms: number; children?: number[] });
    const noches = calcularNoches(preview.checkin, preview.checkout);

    // 4. ReservarCupos (disponibilidad, su propia transacción): bloquea las noches, comprueba el cupo y lo descuenta con la
    //    orden como clave. La retención es provisional hasta el paso 7. Si algo de abajo falla, `crear` la devuelve.
    const saga = await this.sagas.tomar('crearOrdenV1', idempotencyKey, null);
    const ordenId = saga.ordenId;
    const reserva = habitacion?.activo
      ? await this.disponibilidad.reservarCupos({ ordenId, habitacionId: preview.habitacionId, checkin: preview.checkin, checkout: preview.checkout, cantidad: reparto.habitaciones })
      : null;
    if (!reserva?.ok || reserva.noches.length !== noches) {
      throw new ConflictoException('ROOM_NO_LONGER_AVAILABLE', 'La habitación ya no tiene cupos suficientes en todas las noches', [
        { name: 'order_preview_id', reason: 'Otra reserva tomó los cupos: pide una nueva vista previa' },
      ]);
    }
    // 5. Precio con las noches bloqueadas: suma en centavos, igual que la vista previa
    const totalNoches = reserva.noches.reduce((suma, n) => suma + Math.round(n.precio * 100), 0) / 100;
    const total = precioOrden(totalNoches, reparto.habitaciones);
    if (total !== Number(preview.totalPrice)) {
      throw new ConflictoException('PRICE_CHANGED', `El precio cambió de ${preview.totalPrice} a ${total}: pide una nueva vista previa`);
    }

    // 6. Orden y clave de idempotencia, en la misma transacción. Lo que la orden muestra del catálogo se copia aquí.
    const orden = await manager.save(
      manager.create(Orden, {
        id: ordenId,
        locator: await this.generarLocator(manager),
        status: OrdenStatus.CONFIRMED, // pago simulado: se considera aprobado
        alojamientoId: alojamiento.id,
        habitacionId: preview.habitacionId,
        alojamientoCodigo: alojamiento.codigo,
        alojamientoNombre: alojamiento.nombre,
        habitacionCodigo: habitacion.codigo,
        habitacionNombre: habitacion.nombre,
        habitacionCancellationType: habitacion.cancellationType,
        habitacionMealPlan: habitacion.mealPlan,
        previewId: preview.id,
        habitacionesReservadas: reparto.habitaciones,
        guests: preview.guests,
        checkin: preview.checkin,
        checkout: preview.checkout,
        customerFirstName: request.customer_details.first_name,
        customerLastName: request.customer_details.last_name,
        customerEmail: request.customer_details.email,
        totalPrice: total,
        currency: preview.currency,
        paymentReference: request.payment_reference,
        clienteId, // null = compra sin cuenta
      }),
    );

    const detalle = this.aDetalle(orden);
    // Evento de la reserva, en esta misma transacción (outbox de reservas)
    await this.eventos.emitirReserva(manager, 'alojamiento.reserva.confirmada', orden, alojamiento.codigo);
    await manager.insert(IdempotencyKey, {
      key: idempotencyKey,
      endpoint: ENDPOINT_CREATE,
      statusCode: 201,
      // El tipo de insert() de TypeORM no acepta objetos con tipo propio en una columna jsonb.
      responseBody: detalle as any,
      requestHash: huella,
    });
    // 7. Confirmar la retención (disponibilidad): deja de vencer. Sin aviso de stock (habitación null): saldrá cuando esta
    //    transacción se confirme. Si esta transacción falla después, `crear` devuelve los cupos y Booking no recibió nada.
    const confirmacion = await this.disponibilidad.confirmarRetencion(orden.id, null, []);
    if (confirmacion === 'LIBERADA' || confirmacion === 'SIN_RETENCION') {
      throw new ConflictoException('ROOM_NO_LONGER_AVAILABLE', 'La retención de cupos venció antes de confirmar la reserva', [
        { name: 'order_preview_id', reason: 'Vuelve a intentarlo con una nueva vista previa' },
      ]);
    }
    await this.sagas.anotar(saga.id, 'RETENCION_CONFIRMADA', undefined, manager);
    return { respuesta: { statusCode: 201, body: detalle }, aviso: { sagaId: saga.id, ordenId: orden.id, habitacion, fechas: nochesDe(preview.checkin, preview.checkout) } };
  }

  private repetirRespuesta(guardada: IdempotencyKey, huella: string): RespuestaCreacion {
    if (guardada.endpoint !== ENDPOINT_CREATE || guardada.requestHash !== huella) {
      throw new ClaveIdempotenciaReutilizadaException([
        { name: 'Idempotency-Key', reason: 'Esta clave ya se usó con un cuerpo distinto: usa una clave nueva' },
      ]);
    }
    return { statusCode: guardada.statusCode, body: guardada.responseBody as OrderDetailDto };
  }

  // ───────────────────────── GET /orders/{orderId} ─────────────────────────

  async obtener(orderId: string): Promise<OrderDetailDto> {
    const orden = await this.ordenesRepository.findOneBy({ id: orderId });
    if (!orden) throw this.ordenNoEncontrada(orderId);
    return this.aDetalle(orden);
  }

  // El catálogo del preview, por su id (sin bloquearlo: sus ids no cambian). null si el id no es válido o no existe:
  // dentro de la transacción se responde lo de siempre (400 «La vista previa no existe»).
  private async catalogoDelPreview(previewId: string): Promise<CatalogoDelPreview | null> {
    const preview = esUuid(previewId) ? await this.previewsRepository.findOneBy({ id: previewId }) : null;
    if (!preview) return null;
    const alojamiento = await this.catalogo.alojamientoActivoPorId(preview.alojamientoId);
    const habitacion = (await this.catalogo.habitacionesPorIds([preview.habitacionId])).get(preview.habitacionId) ?? null;
    return { previewId: preview.id, alojamiento, habitacion };
  }

  private async habitacionParaStock(habitacionId: string): Promise<RefHabitacionStock | null> {
    return (await this.catalogo.habitacionesPorIds([habitacionId])).get(habitacionId) ?? null;
  }

  // ───────────────────────── POST /orders/{orderId}/cancel ─────────────────────────

  // Pasa la orden a CANCELLED y devuelve los cupos, en una transacción. La fila de la orden se bloquea
  // para que dos cancelaciones simultáneas no devuelvan los cupos dos veces. Si ya estaba cancelada,
  // responde la orden tal cual. No se aplica política de cancelación: el contrato no la define.
  // `auditor`: si la cancelación la hace un administrador, se escribe la fila de auditoría en la misma transacción.
  async cancelar(orderId: string, auditor?: { usuarioId: string }): Promise<OrderDetailDto> {
    // Fase 8.2: la habitación para el aviso de stock se lee del catálogo antes de abrir la transacción (la de una orden no cambia)
    const previa = esUuid(orderId) ? await this.ordenesRepository.findOneBy({ id: orderId }) : null;
    const habitacion = previa ? await this.habitacionParaStock(previa.habitacionId) : null;
    // Los cupos se devuelven y el stock se avisa cuando la transacción de la cancelación ya se confirmó (8.5): si esa falla no se libera
    // ningún cupo (no hay sobreventa) ni queda ningún aviso
    const pendiente: { cancelacion?: CancelacionPendiente } = {};
    await this.dataSource.transaction(async (manager) => {
      const orden = await manager
        .getRepository(Orden)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :orderId', { orderId })
        .getOne();
      if (!orden) throw this.ordenNoEncontrada(orderId);
      if (orden.status === OrdenStatus.CANCELLED) return;
      // Con el huésped ya alojado (o ya salido) la reserva no se cancela: los cupos no se devuelven a una estancia en curso
      if (orden.status === OrdenStatus.CHECKED_IN || orden.status === OrdenStatus.CHECKED_OUT) {
        throw new ConflictoException('CANCELLATION_NOT_ALLOWED', `No se puede cancelar una reserva en estado ${orden.status}`);
      }

      // LiberarCupos (disponibilidad): devuelve exactamente lo que esta orden retuvo, una sola vez.
      orden.status = OrdenStatus.CANCELLED;
      orden.canceladaEn = new Date();
      await manager.save(orden);
      if (previa?.habitacionId !== orden.habitacionId) throw new Error(`La habitación de la orden ${orden.id} no se leyó antes de la transacción`);
      await this.eventos.emitirReserva(manager, 'alojamiento.reserva.cancelada', orden, orden.alojamientoCodigo);
      await this.sagas.registrarCancelacion(manager, orden.id, null);
      pendiente.cancelacion = { ordenId: orden.id, habitacion, fechas: nochesDe(orden.checkin, orden.checkout), correlacion: null };
      if (auditor) {
        await this.auditoria.registrar(manager, {
          modulo: 'reservas',
          usuarioId: auditor.usuarioId,
          accion: 'cancelar',
          entidad: 'orden',
          entidadId: orden.id,
          antes: { status: OrdenStatus.CONFIRMED, habitacionesReservadas: orden.habitacionesReservadas },
          despues: { status: OrdenStatus.CANCELLED },
        });
      }
    });
    if (pendiente.cancelacion) await this.sagas.terminarCancelacion(pendiente.cancelacion);
    return this.obtener(orderId);
  }

  // ───────────────────────── Consultas de cuenta y de administración ─────────────────────────

  // Reservas de un cliente con cuenta, más recientes primero.
  async listarDeCliente(clienteId: string, estado: OrdenStatus | undefined, pagina: number, limite: number) {
    return this.listar({ clienteId, estado }, pagina, limite);
  }

  // Reservas de los alojamientos de un administrador (propietarioId = null => todas, para el superadmin).
  async listarDeAlojamientos(propietarioId: string | null, filtro: { estado?: OrdenStatus; alojamientoId?: number }, pagina: number, limite: number) {
    return this.listar({ propietarioId, ...filtro }, pagina, limite);
  }

  private async listar(
    filtro: { clienteId?: string; propietarioId?: string | null; estado?: OrdenStatus; alojamientoId?: number },
    pagina: number,
    limite: number,
  ) {
    const consulta = this.ordenesRepository
      .createQueryBuilder('o')
      .orderBy('o.createdAt', 'DESC')
      .addOrderBy('o.id', 'ASC')
      .skip((pagina - 1) * limite)
      .take(limite);
    if (filtro.clienteId) consulta.andWhere('o.clienteId = :clienteId', { clienteId: filtro.clienteId });
    // Los alojamientos de un administrador los dice el catálogo
    if (filtro.propietarioId) {
      const suyos = await this.catalogo.idsDeAlojamientosDe(filtro.propietarioId);
      consulta.andWhere(suyos.length ? 'o.alojamientoId IN (:...suyos)' : '1 = 0', { suyos });
    }
    if (filtro.estado) consulta.andWhere('o.status = :estado', { estado: filtro.estado });
    if (filtro.alojamientoId !== undefined) consulta.andWhere('o.alojamientoId = :alojamientoId', { alojamientoId: filtro.alojamientoId });
    const [ordenes, total] = await consulta.getManyAndCount();
    return {
      data: ordenes.map((o) => {
        const detalle = this.aDetalle(o);
        // El administrador necesita saber quién reservó; el cliente en su cuenta ya lo sabe.
        return 'propietarioId' in filtro
          ? { ...detalle, customer_details: { first_name: o.customerFirstName, last_name: o.customerLastName, email: o.customerEmail }, cliente_id: o.clienteId }
          : detalle;
      }),
      meta: { totalItems: total, itemCount: ordenes.length, itemsPerPage: limite, totalPages: Math.ceil(total / limite), currentPage: pagina },
    };
  }

  // Una reserva de "Mis reservas" por su localizador: solo si la hizo este cliente con su sesión.
  // Si es de otro (o no existe) => 404, sin revelar cuál de los dos casos es.
  async obtenerDeCliente(clienteId: string, localizador: string): Promise<OrderDetailDto> {
    const locator = localizador.trim().toUpperCase();
    const orden = /^[A-Z0-9]{4,50}$/.test(locator)
      ? await this.ordenesRepository.findOneBy({ locator, clienteId })
      : null;
    if (!orden) {
      const reason = 'No tienes una reserva con ese localizador';
      throw new RecursoNoEncontradoException(reason, [{ name: 'localizador', reason }]);
    }
    return this.aDetalle(orden);
  }

  // Compra sin cuenta: localizador + correo. Si no coinciden => 404, igual que si el localizador no existiera.
  async consultarPorLocalizador(localizador: string, correo: string): Promise<OrderDetailDto> {
    const orden = await this.ordenesRepository
      .createQueryBuilder('o')
      .where('o.locator = :localizador', { localizador: localizador.trim().toUpperCase() })
      .andWhere('LOWER(o.customerEmail) = LOWER(:correo)', { correo: correo.trim() })
      .getOne();
    if (!orden) {
      const reason = 'No hay una reserva con ese localizador y correo';
      throw new RecursoNoEncontradoException(reason, [{ name: 'localizador', reason }]);
    }
    return this.aDetalle(orden);
  }

  // ───────────────────────── Apoyo ─────────────────────────

  private async generarLocator(manager: EntityManager): Promise<string> {
    for (let intento = 0; intento < 5; intento++) {
      const locator = Array.from({ length: LARGO_LOCATOR }, () => ALFABETO_LOCATOR[randomInt(ALFABETO_LOCATOR.length)]).join('');
      if (!(await manager.existsBy(Orden, { locator }))) return locator;
    }
    throw new Error('No se pudo generar un localizador único');
  }

  // Todo sale de la orden: el nombre del alojamiento y de la habitación se copiaron al reservar
  private aDetalle(orden: Orden): OrderDetailDto {
    const base = `/api/v1/orders/${orden.id}`;
    return {
      order_id: orden.id,
      locator: orden.locator,
      status: orden.status,
      accommodation_details: {
        accommodation_id: orden.alojamientoId,
        name: orden.alojamientoNombre,
        product_id: orden.habitacionId,
        room_name: orden.habitacionNombre,
        cancellation_type: orden.habitacionCancellationType,
        checkin: orden.checkin,
        checkout: orden.checkout,
        nights: calcularNoches(orden.checkin, orden.checkout),
        rooms: orden.habitacionesReservadas,
        guests: orden.guests,
      },
      total_price: Number(orden.totalPrice),
      currency: orden.currency,
      creation_date: new Date(orden.createdAt).toISOString(),
      _links:
        orden.status === OrdenStatus.CANCELLED
          ? { self: base }
          : { self: base, modify: `${base}/modify`, cancel: `${base}/cancel` },
    };
  }

  private ordenNoEncontrada(orderId: string): RecursoNoEncontradoException {
    const reason = `La orden ${orderId} no existe`;
    return new RecursoNoEncontradoException(reason, [{ name: 'orderId', reason }]);
  }

  private previewYaUsado(): ConflictoException {
    return new ConflictoException(
      'ROOM_NO_LONGER_AVAILABLE',
      'La vista previa ya se usó para crear una orden: pide una nueva con /orders/preview',
      [{ name: 'order_preview_id', reason: 'ya se usó para crear una orden' }],
    );
  }

  // Datos de una violación de UNIQUE (23505) de PostgreSQL; undefined si el error es otro.
  private violacionUnica(error: unknown): { table?: string; constraint?: string } | undefined {
    const driver = error instanceof QueryFailedError ? (error.driverError as { code?: string; table?: string; constraint?: string }) : undefined;
    return driver?.code === '23505' ? driver : undefined;
  }
}

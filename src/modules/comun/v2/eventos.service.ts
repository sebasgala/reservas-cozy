import { randomUUID } from 'crypto';
import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TipoEvento } from '../entities/feed-evento.entity';
import { aCentavos, centavosAMoney } from './dinero';
import { nodoCodigo } from '../codigos';

// Feed de eventos del contrato v2 (GET /alojamientos/eventos), formato CloudEvents 1.0.
//
// Fase 8, opción A: quien provoca el evento lo escribe en la outbox de SU dominio, dentro de su propia transacción, sin
// número y sin tocar ningún contador compartido. Si la transacción se deshace, el evento nunca existió. El publicador
// (publicador-eventos.service.ts) es el único que asigna `sequence` (1, 2, 3, sin huecos) y escribe feed_eventos.
//
// Entrega al menos una vez: el consumidor guarda el último `sequence` y deduplica por `id`.
// Sin datos personales (LOPDP §7.1): solo identificadores y cifras.

// De qué dominio es cada tipo de evento, y por tanto en qué outbox se escribe. usuarios y catálogo todavía no emiten.
const OUTBOX_DE_TIPO: Record<TipoEvento, 'reservas' | 'disponibilidad'> = {
  'alojamiento.reserva.confirmada': 'reservas',
  'alojamiento.reserva.cancelada': 'reservas',
  'alojamiento.checkin.completado': 'reservas',
  'alojamiento.checkout.completado': 'reservas',
  'alojamiento.stock.actualizado': 'disponibilidad',
};
const INSERTAR_EN = {
  reservas: `INSERT INTO "reservas"."outbox_reservas" ("eventoId", "tipo", "sujeto", "alojamientoId", "correlacionId", "datos") VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
  disponibilidad: `INSERT INTO "disponibilidad"."outbox_disponibilidad" ("eventoId", "tipo", "sujeto", "alojamientoId", "correlacionId", "datos") VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
};

// Lo que el evento de una reserva necesita de la orden
export interface OrdenParaEvento {
  id: string;
  locator: string;
  sagaId: string | null;
  status: string;
  alojamientoId: number;
  totalPrice: number;
  // Para que disponibilidad/ descuente o libere las noches exactas sin leer la orden
  habitacionCodigo: string;
  checkin: string;
  checkout: string;
}

// Evento INTERNO entre microservicios (no es del contrato B2B): no entra al feed de Booking.
export const EVENTO_HABITACION_LIMPIA_LISTA = 'habitacion.limpia.lista';

export interface EventoNuevo {
  tipo: TipoEvento;
  sujeto: string;
  alojamientoId: number | null;
  datos: Record<string, unknown>;
}

@Injectable()
export class EventosService {
  constructor(@Optional() @InjectDataSource() private readonly dataSource?: DataSource) {}

  private exigirDataSource(): DataSource {
    if (!this.dataSource) {
      throw new Error('La conexión de comun solo está disponible en el proceso comun o el monolito.');
    }
    return this.dataSource;
  }

  // Registra los eventos en la outbox de su dominio, dentro de la transacción de quien los provoca. Va una fila por
  // sentencia y en el orden recibido: cada una toma su propio clock_timestamp() y el publicador respeta ese orden.
  async emitir(manager: EntityManager, eventos: EventoNuevo[], correlacionId: string | null = null): Promise<void> {
    for (const e of eventos) {
      await manager.query(INSERTAR_EN[OUTBOX_DE_TIPO[e.tipo]], [randomUUID(), e.tipo, e.sujeto.slice(0, 200), e.alojamientoId, correlacionId, JSON.stringify(e.datos)]);
    }
  }

  // alojamiento.reserva.confirmada / alojamiento.reserva.cancelada de una orden (de la v1 o de la v2)
  async emitirReserva(manager: EntityManager, tipo: 'alojamiento.reserva.confirmada' | 'alojamiento.reserva.cancelada', orden: OrdenParaEvento, alojamientoCodigo: string, correlacionId: string | null = null): Promise<void> {
    await this.emitir(
      manager,
      [
        {
          tipo,
          sujeto: `orders/${orden.id}`,
          alojamientoId: orden.alojamientoId,
          datos: {
            orderId: orden.id,
            external_order_id: `ORD-HTL-${orden.locator}`,
            ...(orden.sagaId && { saga_id: orden.sagaId }),
            estado: orden.status,
            alojamientoId: alojamientoCodigo,
            tipoHabitacionCodigo: orden.habitacionCodigo,
            checkin: orden.checkin,
            checkout: orden.checkout,
            total: centavosAMoney(aCentavos(Number(orden.totalPrice))),
          },
        },
      ],
      correlacionId,
    );
  }

  // Evento INTERNO habitacion.limpia.lista: se escribe en outbox_reservas, pero el publicador NO lo copia a
  // comun.feed_eventos (no es del contrato). Lo consume disponibilidad/ para reabrir el inventario físico.
  async emitirHabitacionLimpiaLista(
    manager: EntityManager,
    sujeto: string,
    alojamientoId: number,
    datos: Record<string, unknown>,
    correlacionId: string | null = null,
  ): Promise<void> {
    await manager.query(INSERTAR_EN.reservas, [randomUUID(), EVENTO_HABITACION_LIMPIA_LISTA, sujeto.slice(0, 200), alojamientoId, correlacionId, JSON.stringify(datos)]);
  }

  // Último `sequence` publicado (estado de la outbox del panel)
  async ultimoSequence(): Promise<number> {
    const [fila] = await this.exigirDataSource().query(`SELECT "ultimo"::bigint AS "ultimo" FROM "comun"."feed_publicador" WHERE "id" = 1`);
    return Number(fila.ultimo);
  }

  // GET /alojamientos/eventos. `alojamientos`: null = todos; si no, solo los de esos ids (un administrador no
  // superadmin ve los de sus alojamientos, que le da el catálogo, y por eso puede notar saltos).
  async listar(after: number, limit: number, tipo: TipoEvento | undefined, alojamientos: number[] | null) {
    const valores: unknown[] = [after];
    const condiciones = ['e."sequence" > $1'];
    if (tipo) {
      valores.push(tipo);
      condiciones.push(`e."tipo" = $${valores.length}`);
    }
    if (alojamientos) {
      valores.push(alojamientos);
      condiciones.push(`e."alojamientoId" = ANY($${valores.length}::int[])`);
    }
    const filas: { sequence: string; id: string; tipo: TipoEvento; sujeto: string; correlacionId: string | null; datos: Record<string, unknown>; creadoEn: Date }[] = await this.exigirDataSource().query(
      `SELECT e."sequence", e."id", e."tipo", e."sujeto", e."correlacionId", e."datos", e."creadoEn" FROM "comun"."feed_eventos" e WHERE ${condiciones.join(' AND ')} ORDER BY e."sequence" LIMIT ${limit + 1}`,
      valores,
    );
    const pagina = filas.slice(0, limit);
    return {
      eventos: pagina.map((f) => ({
        id: f.id,
        source: `urn:${nodoCodigo().toLowerCase()}:alojamientos`,
        specversion: '1.0',
        type: f.tipo,
        time: new Date(f.creadoEn).toISOString(),
        sequence: Number(f.sequence),
        subject: f.sujeto,
        ...(f.correlacionId && { correlationid: f.correlacionId }),
        datacontenttype: 'application/json',
        data: f.datos,
      })),
      has_more: filas.length > limit,
      next_after: pagina.length > 0 ? Number(pagina[pagina.length - 1].sequence) : after,
    };
  }
}

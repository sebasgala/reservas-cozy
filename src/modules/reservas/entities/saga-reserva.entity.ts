import { Check, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

// Estado de la saga de una compra (fase 8.4): reservas orquesta, cada paso corre en la transacción de su dominio y aquí
// queda por dónde va, para retomarla con la misma Idempotency-Key o desde el barrido. La clave de todos los pasos de
// disponibilidad es ordenId (idempotentes por orden). Sin datos personales del titular: están en la orden.
//   INICIADA → CUPOS_RETENIDOS → ORDEN_CREADA → RETENCION_CONFIRMADA → CONFIRMADA
//   un fallo antes de RETENCION_CONFIRMADA → COMPENSANDO → COMPENSADA (o FALLIDA si la compensación no se pudo terminar)
//   cancelarOrden (8.5, una fila por orden cancelada, creada en la misma transacción que la cancelación): INICIADA = la orden ya está
//   CANCELLED y faltan devolver los cupos y avisar el stock; CONFIRMADA = hecho. La termina la petición o, si el proceso cayó, el barrido.
//   desde RETENCION_CONFIRMADA ya no se compensa: se termina hacia adelante (orden CONFIRMED, evento y, solo después de
//   confirmar esa transacción, el aviso de stock a Booking). CONFIRMADA = orden confirmada Y aviso de stock encolado.
export const ESTADOS_SAGA = ['INICIADA', 'CUPOS_RETENIDOS', 'ORDEN_CREADA', 'RETENCION_CONFIRMADA', 'CONFIRMADA', 'COMPENSANDO', 'COMPENSADA', 'FALLIDA'] as const;
export type EstadoSaga = (typeof ESTADOS_SAGA)[number];
export type OperacionSaga = 'createOrder' | 'crearOrdenV1' | 'cancelarOrden';

@Entity({ name: 'sagas_reserva', schema: 'reservas' })
@Unique('UQ_sagas_reserva_clave', ['operacion', 'claveIdempotencia'])
@Check('CHK_sagas_reserva_estado', `"estado" IN (${ESTADOS_SAGA.map((e) => `'${e}'`).join(', ')})`)
@Index('IDX_sagas_reserva_pendientes', ['estado', 'actualizadaEn'])
export class SagaReserva {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_sagas_reserva' })
  id: string;

  @Index('IDX_sagas_reserva_orden')
  @Column({ type: 'uuid' })
  ordenId: string;

  @Column({ type: 'varchar', length: 30 })
  operacion: OperacionSaga;

  @Column({ type: 'varchar', length: 255 })
  claveIdempotencia: string;

  @Column({ type: 'varchar', length: 25, default: 'INICIADA' })
  estado: EstadoSaga;

  @Column({ type: 'varchar', length: 25, nullable: true })
  pasoFallido: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;

  @Column({ type: 'int', default: 0 })
  intentos: number;

  // Lo que el barrido necesita para terminar sin volver a leer otros dominios (por ejemplo, el correlationId)
  @Column({ type: 'jsonb', nullable: true })
  datos: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  creadaEn: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  actualizadaEn: Date;
}

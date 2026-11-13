import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Bloque R (R9): auditoría LOCAL de la recepción. Cada cambio operativo sobre una reserva deja una fila en la
// misma transacción que el cambio. Nunca se envía a Booking.
export const ACCIONES_RECEPCION = [
  'CHECKIN_APROBADO',
  'REASIGNACION_HABITACION',
  'CAMBIO_GUEST_COUNT',
  'CAMBIO_OBSERVACIONES',
  'EARLY_CHECKIN_AUTORIZADO',
  'HABITACION_LIMPIA_LISTA',
  'RESERVA_ARCHIVADA',
] as const;
export type AccionRecepcion = (typeof ACCIONES_RECEPCION)[number];

@Entity({ name: 'auditoria_recepcion', schema: 'reservas' })
@Index('IX_auditoria_recepcion_alojamiento', ['alojamientoId', 'creadoEn'])
export class AuditoriaRecepcion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'alojamiento_id', type: 'int' })
  alojamientoId: number;

  @Index('IX_auditoria_recepcion_reserva')
  @Column({ name: 'reserva_id', type: 'uuid' })
  reservaId: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @Column({ type: 'varchar', length: 20 })
  rol: string;

  @Column({ type: 'varchar', length: 40 })
  accion: AccionRecepcion;

  @Column({ type: 'varchar', length: 300, nullable: true })
  motivo: string | null;

  @Column({ name: 'datos_previos', type: 'jsonb', nullable: true })
  datosPrevios: Record<string, unknown> | null;

  @Column({ name: 'datos_nuevos', type: 'jsonb', nullable: true })
  datosNuevos: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'creado_en', type: 'timestamptz' })
  creadoEn: Date;
}

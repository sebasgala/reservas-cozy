import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { ColumnNumericTransformer } from '../../../common/transformers/column-numeric.transformer';
import { Orden } from './orden.entity';

export const TIPOS_VIAJE = ['SOLO', 'PAREJA', 'FAMILIA', 'NEGOCIOS', 'GRUPO'] as const;

// Reseña de una estancia verificada (contrato v2, ResenaUsuarioV2): solo del titular de una reserva CHECKED_OUT y una por reserva.
@Entity({ name: 'resenas', schema: 'reservas' })
@Unique('UQ_resenas_ordenId', ['ordenId'])
@Check('CHK_resenas_calificacion', '"calificacionGlobal" BETWEEN 1 AND 10')
@Check('CHK_resenas_tipoViaje', `"tipoViaje" IS NULL OR "tipoViaje" IN (${TIPOS_VIAJE.map((t) => `'${t}'`).join(', ')})`)
@Index('IX_resenas_alojamientoId', ['alojamientoId', 'creadoEn', 'id'])
export class Resena {
  // El id público del contrato es REV-ALO-<id>
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'uuid' })
  ordenId: string;

  @ManyToOne(() => Orden, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ordenId', foreignKeyConstraintName: 'FK_resenas_ordenId' })
  orden: Orden;

  @Column({ type: 'int' })
  alojamientoId: number;

  @Column({ type: 'uuid', nullable: true })
  clienteId: string | null;

  @Column('numeric', { precision: 4, scale: 2, transformer: new ColumnNumericTransformer() })
  calificacionGlobal: number;

  @Column({ type: 'jsonb', nullable: true })
  desglose: Record<string, number> | null;

  @Column({ type: 'text' })
  comentario: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  tipoViaje: (typeof TIPOS_VIAJE)[number] | null;

  // Primer nombre + inicial del apellido: es lo único del autor que sale en público
  @Column({ type: 'varchar', length: 100 })
  autorNombre: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  autorPais: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tipoHabitacion: string | null;

  @Column({ type: 'date' })
  fecha: string;

  @CreateDateColumn({ type: 'timestamptz' })
  creadoEn: Date;
}

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// Estado de limpieza de la habitación física.
export enum EstadoLimpieza {
  LIMPIA = 'LIMPIA',
  SUCIA = 'SUCIA',
  EN_LIMPIEZA = 'EN_LIMPIEZA',
}

// Habitación física de un alojamiento. Una habitación del catálogo (tipo) puede tener varias físicas (p. ej. 101, 102).
// Si el alojamiento no registra habitaciones físicas (controla_limpieza = false), el check-in sigue sin asignarlas.
@Entity({ name: 'habitaciones_fisicas', schema: 'reservas' })
@Check('CHK_hf_numero', '"numero" <> \'\'')
@Index('IX_hf_alojamiento', ['alojamientoId'])
@Index('IX_hf_alojamiento_numero', ['alojamientoId', 'numero'], { unique: true })
export class HabitacionFisica {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'alojamiento_id', type: 'int' })
  alojamientoId: number;

  // UUID del tipo de habitación del catálogo (habitacion.id)
  @Column({ name: 'tipo_habitacion_id', type: 'uuid' })
  tipoHabitacionId: string;

  // Número o etiqueta visible (p. ej. "101", "Suite Mar")
  @Column({ type: 'varchar', length: 20 })
  numero: string;

  @Column({ type: 'enum', enum: EstadoLimpieza, default: EstadoLimpieza.LIMPIA })
  estadoLimpieza: EstadoLimpieza;

  @Column({ type: 'boolean', default: true })
  activa: boolean;

  @CreateDateColumn({ name: 'creado_en', type: 'timestamptz' })
  creadoEn: Date;

  @UpdateDateColumn({ name: 'actualizado_en', type: 'timestamptz' })
  actualizadoEn: Date;
}

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EstadoLimpieza } from './habitacion-fisica.entity';

@Entity({ name: 'historial_limpieza', schema: 'reservas' })
@Index('IX_historial_limpieza_habitacion', ['habitacionFisicaId', 'cambiadoEn'])
export class HistorialLimpieza {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IX_historial_limpieza_hf')
  @Column({ name: 'habitacion_fisica_id', type: 'uuid' })
  habitacionFisicaId: string;

  @Column({ name: 'reserva_id', type: 'uuid', nullable: true })
  reservaId: string | null;

  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  usuarioId: string | null;

  @Column({ name: 'estado_anterior', type: 'enum', enum: EstadoLimpieza })
  estadoAnterior: EstadoLimpieza;

  @Column({ name: 'estado_nuevo', type: 'enum', enum: EstadoLimpieza })
  estadoNuevo: EstadoLimpieza;

  @Column({ type: 'varchar', length: 300, nullable: true })
  motivo: string | null;

  @CreateDateColumn({ name: 'cambiado_en', type: 'timestamptz' })
  cambiadoEn: Date;
}

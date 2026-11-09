import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ColumnNumericTransformer } from '../../../common/transformers/column-numeric.transformer';

// Su id es el order_preview_id del contrato.
@Entity({ name: 'ordenes_preview', schema: 'reservas' })
@Check('CHK_ordenes_preview_total', '"totalPrice" >= 0')
@Check('CHK_ordenes_preview_fechas', '"checkout" > "checkin"')
export class OrdenPreview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IX_ordenes_preview_alojamientoId')
  @Column({ type: 'int' })
  alojamientoId: number;

  @Index('IX_ordenes_preview_habitacionId')
  @Column({ type: 'uuid' })
  habitacionId: string;

  @Column({ type: 'jsonb' })
  guests: Record<string, any>;

  @Column({ type: 'date' })
  checkin: string;

  @Column({ type: 'date' })
  checkout: string;

  @Column('numeric', {
    precision: 10,
    scale: 2,
    transformer: new ColumnNumericTransformer(),
  })
  totalPrice: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  // Indexado para poder borrar las vistas previas vencidas sin recorrer toda la tabla.
  @Index('IX_ordenes_preview_expiresAt')
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
import { ColumnNumericTransformer } from '../../../common/transformers/column-numeric.transformer';

// Acuerdo B2B de promociones y combos del nodo (contrato v2, ContratoPromocionesResponseV2). Una sola fila (id = 1):
// la fija un administrador con PUT /alojamientos/promociones/contrato. Sin fila, el nodo NO acepta promociones.
@Entity({ name: 'promociones_contrato', schema: 'reservas' })
@Check('CHK_promociones_contrato_unica', '"id" = 1')
@Check('CHK_promociones_contrato_porcentaje', '"porcentajeMaximo" BETWEEN 0 AND 50 AND ("permitePromociones" OR "porcentajeMaximo" = 0)')
export class PromocionContrato {
  @PrimaryColumn({ type: 'smallint', default: 1, primaryKeyConstraintName: 'PK_promociones_contrato' })
  id: number;

  @Column({ type: 'boolean' })
  permitePromociones: boolean;

  @Column('numeric', { precision: 5, scale: 2, transformer: new ColumnNumericTransformer() })
  porcentajeMaximo: number;

  // Nombres de ciudad. Vacío = todos los destinos del nodo
  @Column({ type: 'jsonb', default: () => `'[]'` })
  destinos: string[];

  @Column({ type: 'date' })
  vigenciaDesde: string;

  @Column({ type: 'date', nullable: true })
  vigenciaHasta: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  condicionesCombo: string | null;

  // Datos personales (x-pii): no van a logs
  @Column({ type: 'jsonb', nullable: true })
  contactoComercial: Record<string, string> | null;

  @Column({ type: 'uuid', nullable: true })
  actualizadoPor: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

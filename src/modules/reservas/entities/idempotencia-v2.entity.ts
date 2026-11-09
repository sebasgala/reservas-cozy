import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Idempotency-Key del contrato v2 (§1.2) en orders/create y orders/{id}/cancel. Aparte de idempotency_keys (v1),
// porque la v2 necesita el estado "en curso" y guarda también las respuestas de error definitivas.
//   EN_CURSO    la primera petición todavía se está procesando (otra con la misma clave recibe 409)
//   COMPLETADA  respuesta guardada: un reintento con el mismo cuerpo recibe exactamente esa respuesta
@Entity({ name: 'idempotencia_v2', schema: 'reservas' })
@Check('CHK_idempotencia_v2_estado', `"estado" IN ('EN_CURSO', 'COMPLETADA')`)
export class IdempotenciaV2 {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_idempotencia_v2' })
  clave: string;

  // Operación y recurso: createOrder, o cancelOrder:<orderId>
  @Column({ type: 'varchar', length: 120 })
  operacion: string;

  // SHA-256 de la operación y el cuerpo: detecta la misma clave usada con un cuerpo distinto
  @Column({ type: 'varchar', length: 64 })
  huella: string;

  @Column({ type: 'varchar', length: 12 })
  estado: 'EN_CURSO' | 'COMPLETADA';

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  // `json` (no `jsonb`): conserva el texto tal cual para devolver exactamente la misma respuesta
  @Column({ type: 'json', nullable: true })
  respuesta: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  cabeceras: Record<string, string> | null;

  @Column({ type: 'timestamptz' })
  creadaEn: Date;

  @Column({ type: 'timestamptz' })
  actualizadaEn: Date;

  // Retención mínima del contrato: 24 horas
  @Index('IX_idempotencia_v2_expiraEn')
  @Column({ type: 'timestamptz' })
  expiraEn: Date;
}

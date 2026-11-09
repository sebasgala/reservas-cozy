import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

// Guarda la respuesta de cada Idempotency-Key para devolver lo mismo si el cliente reintenta.
@Entity({ name: 'idempotency_keys', schema: 'reservas' })
export class IdempotencyKey {
  @PrimaryColumn({ type: 'uuid' })
  key: string;

  @Column({ type: 'varchar', length: 255 })
  endpoint: string;

  @Column({ type: 'int' })
  statusCode: number;

  // `json` (no `jsonb`): conserva el texto tal cual, con el mismo orden de claves, para que un
  // reintento devuelva exactamente la misma respuesta.
  @Column({ type: 'json', nullable: true })
  responseBody: Record<string, any> | null;

  // SHA-256 del cuerpo de la petición: detecta la misma clave usada con un cuerpo distinto.
  @Column({ type: 'varchar', length: 64 })
  requestHash: string;

  // Indexado para poder borrar las claves viejas sin recorrer toda la tabla.
  @Index('IX_idempotency_keys_createdAt')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

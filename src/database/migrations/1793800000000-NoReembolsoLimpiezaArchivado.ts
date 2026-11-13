import { MigrationInterface, QueryRunner } from 'typeorm';

// Fase 2 (reservas): flujo post-check-out con limpieza obligatoria, archivado en recepción y evento interno.
//   ordenes_status_enum   dos estados internos nuevos (POR_LIMPIAR, LIMPIA_LISTA); nunca salen al contrato.
//   ordenes               columna archivada_recepcion (saca la reserva del tablero activo) y CHK_ordenes_estancia
//                         ampliado: POR_LIMPIAR y LIMPIA_LISTA exigen checkInEn y checkOutEn (vienen tras el check-out).
//   outbox_reservas       admite el evento INTERNO habitacion.limpia.lista (CHK_..._tipo) y el centinela sequence = 0
//                         (CHK_..._sequence), con el que el publicador marca un evento interno como procesado SIN
//                         copiarlo a comun.feed_eventos (que solo admite los cinco tipos del contrato).
// Los valores nuevos del enum no se usan como literal de enum en esta transacción (PostgreSQL lo prohíbe): los CHECK
// comparan contra texto (::text).
export class NoReembolsoLimpiezaArchivado1793800000000 implements MigrationInterface {
  name = 'NoReembolsoLimpiezaArchivado1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Estados internos del flujo de limpieza
    await queryRunner.query(`ALTER TYPE "reservas"."ordenes_status_enum" ADD VALUE IF NOT EXISTS 'POR_LIMPIAR'`);
    await queryRunner.query(`ALTER TYPE "reservas"."ordenes_status_enum" ADD VALUE IF NOT EXISTS 'LIMPIA_LISTA'`);

    // 2. Archivado en recepción
    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" ADD COLUMN IF NOT EXISTS "archivada_recepcion" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_ordenes_archivadaRecepcion" ON "reservas"."ordenes" ("archivada_recepcion")`);

    // 3. CHK_ordenes_estancia: los estados post-check-out exigen checkInEn y checkOutEn
    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" DROP CONSTRAINT IF EXISTS "CHK_ordenes_estancia"`);
    await queryRunner.query(`
      ALTER TABLE "reservas"."ordenes" ADD CONSTRAINT "CHK_ordenes_estancia" CHECK (
        ("status"::text NOT IN ('CHECKED_IN', 'CHECKED_OUT', 'POR_LIMPIAR', 'LIMPIA_LISTA') OR "checkInEn" IS NOT NULL)
        AND ("status"::text NOT IN ('CHECKED_OUT', 'POR_LIMPIAR', 'LIMPIA_LISTA') OR "checkOutEn" IS NOT NULL)
        AND ("consumosAdicionales" IS NULL OR "consumosAdicionales" >= 0)
      )
    `);

    // 4. outbox_reservas: permitir el evento interno y el centinela sequence = 0
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" DROP CONSTRAINT IF EXISTS "CHK_outbox_reservas_tipo"`);
    await queryRunner.query(`
      ALTER TABLE "reservas"."outbox_reservas" ADD CONSTRAINT "CHK_outbox_reservas_tipo" CHECK ("tipo" IN (
        'alojamiento.reserva.confirmada',
        'alojamiento.reserva.cancelada',
        'alojamiento.checkin.completado',
        'alojamiento.checkout.completado',
        'alojamiento.stock.actualizado',
        'habitacion.limpia.lista'
      ))
    `);
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" DROP CONSTRAINT IF EXISTS "CHK_outbox_reservas_sequence"`);
    // sequence = 0: evento interno ya procesado por el publicador pero que NO va al feed del contrato
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" ADD CONSTRAINT "CHK_outbox_reservas_sequence" CHECK ("sequence" IS NULL OR "sequence" >= 0)`);
  }

  // Los valores del enum no se pueden quitar de PostgreSQL: quedan (sin uso) al revertir.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" DROP CONSTRAINT IF EXISTS "CHK_outbox_reservas_sequence"`);
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" ADD CONSTRAINT "CHK_outbox_reservas_sequence" CHECK ("sequence" IS NULL OR "sequence" >= 1)`);
    await queryRunner.query(`ALTER TABLE "reservas"."outbox_reservas" DROP CONSTRAINT IF EXISTS "CHK_outbox_reservas_tipo"`);
    await queryRunner.query(`
      ALTER TABLE "reservas"."outbox_reservas" ADD CONSTRAINT "CHK_outbox_reservas_tipo" CHECK ("tipo" IN (
        'alojamiento.reserva.confirmada',
        'alojamiento.reserva.cancelada',
        'alojamiento.checkin.completado',
        'alojamiento.checkout.completado',
        'alojamiento.stock.actualizado'
      ))
    `);

    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" DROP CONSTRAINT IF EXISTS "CHK_ordenes_estancia"`);
    await queryRunner.query(`
      ALTER TABLE "reservas"."ordenes" ADD CONSTRAINT "CHK_ordenes_estancia" CHECK (
        ("status"::text NOT IN ('CHECKED_IN', 'CHECKED_OUT') OR "checkInEn" IS NOT NULL)
        AND ("status"::text <> 'CHECKED_OUT' OR "checkOutEn" IS NOT NULL)
        AND ("consumosAdicionales" IS NULL OR "consumosAdicionales" >= 0)
      )
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "reservas"."IX_ordenes_archivadaRecepcion"`);
    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" DROP COLUMN IF EXISTS "archivada_recepcion"`);
  }
}

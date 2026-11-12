import { MigrationInterface, QueryRunner } from 'typeorm';

// Bloque F1: la habitación física pasa a OCUPADA en el check-in y a SUCIA en el check-out; MANTENIMIENTO la bloquea.
// No toca OrdenStatus ni el contrato v2.2.0 (estado interno de limpieza).
// También agrega creado_en / actualizado_en, que la entidad HabitacionFisica declara y 1793600000000 no creó.
export class EstadosHabitacionFisica1793700000000 implements MigrationInterface {
  name = 'EstadosHabitacionFisica1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "reservas"."estado_limpieza_enum" ADD VALUE IF NOT EXISTS 'OCUPADA'`);
    await queryRunner.query(`ALTER TYPE "reservas"."estado_limpieza_enum" ADD VALUE IF NOT EXISTS 'MANTENIMIENTO'`);
    await queryRunner.query(`ALTER TABLE "reservas"."habitaciones_fisicas" ADD COLUMN IF NOT EXISTS "creado_en" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "reservas"."habitaciones_fisicas" ADD COLUMN IF NOT EXISTS "actualizado_en" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reservas"."habitaciones_fisicas" DROP COLUMN IF EXISTS "actualizado_en"`);
    await queryRunner.query(`ALTER TABLE "reservas"."habitaciones_fisicas" DROP COLUMN IF EXISTS "creado_en"`);
    // PostgreSQL no permite quitar valores de un enum; los valores sobrantes son inofensivos.
  }
}

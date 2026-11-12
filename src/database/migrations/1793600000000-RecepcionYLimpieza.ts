import { MigrationInterface, QueryRunner } from 'typeorm';

// Bloque R (Fase 2): esquema de recepción y limpieza en reservas/.
//   catalogo.alojamientos
//     - controla_limpieza boolean NOT NULL DEFAULT false: activado automáticamente al registrar la primera habitación física.
//   reservas.auditoria_recepcion: (ya creada por 1793500000000-BloqueRRecepcion; se repite IF NOT EXISTS por robustez)
//   reservas.habitaciones_fisicas: inventario físico del hotel (habitación real, no tipo de habitación del catálogo).
//   reservas.historial_limpieza: registro de cada cambio de estado de limpieza.
//   reservas.ordenes
//     - habitacion_fisica_id uuid NULL: habitación física asignada en el check-in cuando controla_limpieza=true.
const ROL_RESERVAS = 'reservas';
const ROL_CATALOGO = 'catalogo';

export class RecepcionYLimpieza1793600000000 implements MigrationInterface {
  name = 'RecepcionYLimpieza1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. controla_limpieza en alojamientos
    await queryRunner.query(`ALTER TABLE "catalogo"."alojamientos" ADD COLUMN IF NOT EXISTS "controla_limpieza" boolean NOT NULL DEFAULT false`);

    // 2. auditoria_recepcion (idempotente; puede que ya exista por la migración anterior)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reservas"."auditoria_recepcion" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "alojamiento_id" integer NOT NULL,
        "reserva_id" uuid NOT NULL,
        "usuario_id" uuid NOT NULL,
        "rol" character varying(20) NOT NULL,
        "accion" character varying(40) NOT NULL,
        "motivo" character varying(300),
        "datos_previos" jsonb,
        "datos_nuevos" jsonb,
        "creado_en" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auditoria_recepcion" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_auditoria_recepcion_alojamiento" ON "reservas"."auditoria_recepcion" ("alojamiento_id", "creado_en")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_auditoria_recepcion_reserva" ON "reservas"."auditoria_recepcion" ("reserva_id")`);

    // 3. habitaciones_fisicas
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_limpieza_enum' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'reservas')) THEN
          CREATE TYPE "reservas"."estado_limpieza_enum" AS ENUM ('LIMPIA', 'SUCIA', 'EN_LIMPIEZA');
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reservas"."habitaciones_fisicas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "alojamiento_id" integer NOT NULL,
        "tipo_habitacion_id" uuid NOT NULL,
        "numero" character varying(20) NOT NULL,
        "estado_limpieza" "reservas"."estado_limpieza_enum" NOT NULL DEFAULT 'LIMPIA',
        "activa" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_habitaciones_fisicas" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_habitaciones_fisicas_aloj_num" UNIQUE ("alojamiento_id", "numero")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_habitaciones_fisicas_alojamiento" ON "reservas"."habitaciones_fisicas" ("alojamiento_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_habitaciones_fisicas_tipo_estado" ON "reservas"."habitaciones_fisicas" ("alojamiento_id", "tipo_habitacion_id", "estado_limpieza") WHERE "activa" = true`);

    // 4. historial_limpieza
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reservas"."historial_limpieza" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "habitacion_fisica_id" uuid NOT NULL,
        "reserva_id" uuid,
        "usuario_id" uuid,
        "estado_anterior" "reservas"."estado_limpieza_enum" NOT NULL,
        "estado_nuevo" "reservas"."estado_limpieza_enum" NOT NULL,
        "motivo" character varying(300),
        "cambiado_en" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_historial_limpieza" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IX_historial_limpieza_habitacion" ON "reservas"."historial_limpieza" ("habitacion_fisica_id", "cambiado_en")`);

    // 5. habitacion_fisica_id en ordenes
    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" ADD COLUMN IF NOT EXISTS "habitacionFisicaId" uuid`);

    // 6. Permisos
    if (await this.existeRol(queryRunner, ROL_RESERVAS)) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "reservas"."auditoria_recepcion" TO "${ROL_RESERVAS}"`);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "reservas"."habitaciones_fisicas" TO "${ROL_RESERVAS}"`);
      await queryRunner.query(`GRANT SELECT, INSERT ON "reservas"."historial_limpieza" TO "${ROL_RESERVAS}"`);
    }
    if (await this.existeRol(queryRunner, ROL_CATALOGO)) {
      await queryRunner.query(`GRANT SELECT, UPDATE ON "catalogo"."alojamientos" TO "${ROL_CATALOGO}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reservas"."ordenes" DROP COLUMN IF EXISTS "habitacionFisicaId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservas"."historial_limpieza"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservas"."habitaciones_fisicas"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "reservas"."estado_limpieza_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservas"."auditoria_recepcion"`);
    await queryRunner.query(`ALTER TABLE "catalogo"."alojamientos" DROP COLUMN IF EXISTS "controla_limpieza"`);
  }

  private async existeRol(queryRunner: QueryRunner, rol: string): Promise<boolean> {
    return (await queryRunner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [rol])).length > 0;
  }
}

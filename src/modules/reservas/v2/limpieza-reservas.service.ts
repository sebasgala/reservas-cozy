import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CONEXION } from '../../../database/conexiones';

// Limpieza de las tablas de reservas (fase 8.0: cada dominio limpia lo suyo)
//   idempotencia_v2   las claves vencidas (retención del contrato: 24 horas)
@Injectable()
export class LimpiezaReservasService {
  constructor(@InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource) {}

  async limpiar(): Promise<{ idempotencia: number }> {
    const r = await this.dataSource.query(`DELETE FROM "reservas"."idempotencia_v2" WHERE "expiraEn" < now()`);
    return { idempotencia: Array.isArray(r) && typeof r[1] === 'number' ? r[1] : 0 };
  }
}

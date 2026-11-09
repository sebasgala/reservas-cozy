import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { IdempotenciaV2 } from '../entities/idempotencia-v2.entity';
import { ProblemaV2Exception, ExtrasProblema, CodigoErrorV2 } from '../../comun/v2/problemas-v2';
import { CONEXION } from '../../../database/conexiones';

// Idempotencia del contrato v2 (§1.2):
//   primera vez                                → se procesa y se guarda (clave, huella, respuesta)
//   misma clave + mismo cuerpo                 → la MISMA respuesta (status y cuerpo) con Idempotent-Replayed: true
//   misma clave + cuerpo distinto              → 422 IDEMPOTENCY_KEY_REUSED
//   misma clave mientras la primera sigue      → 409 IDEMPOTENCY_IN_PROGRESS + Retry-After
//   retención                                  → 24 horas
//
// La clave se registra EN_CURSO en su propia transacción (así una petición paralela la ve) y se marca COMPLETADA
// dentro de la MISMA transacción que hace el trabajo: nunca queda una orden creada sin su respuesta guardada.
// Si el proceso muere a mitad, la fila queda EN_CURSO; pasado RETOMAR_TRAS_MS otra petición puede retomarla.
//
// `preparar` (fase 8.2): lecturas de otros dominios (el catálogo) que la operación necesita. Corre DESPUÉS de tomar la
// clave y ANTES de abrir la transacción, así nunca se lee el catálogo dentro de ella. Una repetición (misma clave,
// misma petición ya completada) responde lo guardado sin llegar a `preparar`: dar de baja un alojamiento después de
// crear la orden no cambia el 201 que recibe el reintento. Si `preparar` lanza un error de negocio (404, 403), se
// guarda como cualquier otro, igual que si se hubiera lanzado dentro de la transacción.

export const RETENCION_MS = 24 * 60 * 60 * 1000;
export const RETOMAR_TRAS_MS = 60 * 1000;

export type Decision = 'REPETIR' | 'REUTILIZADA' | 'EN_CURSO' | 'RETOMAR' | 'VENCIDA';

export interface FilaIdempotencia {
  operacion: string;
  huella: string;
  estado: 'EN_CURSO' | 'COMPLETADA';
  actualizadaEn: Date;
  expiraEn: Date;
}

// Qué hacer con una petición cuya clave ya existe
export function decidir(fila: FilaIdempotencia, operacion: string, huella: string, ahora: Date): Decision {
  if (fila.expiraEn.getTime() <= ahora.getTime()) return 'VENCIDA';
  if (fila.operacion !== operacion || fila.huella !== huella) return 'REUTILIZADA';
  if (fila.estado === 'COMPLETADA') return 'REPETIR';
  return ahora.getTime() - fila.actualizadaEn.getTime() >= RETOMAR_TRAS_MS ? 'RETOMAR' : 'EN_CURSO';
}

export interface RespuestaIdempotente {
  status: number;
  cuerpo: Record<string, unknown>;
  cabeceras?: Record<string, string>;
  repetida?: boolean;
}

// Error de negocio guardado: al repetirse se lanza otra vez con el mismo status, código y detalle
interface ErrorGuardado {
  error: { codigo: CodigoErrorV2; detalle: string; extras: ExtrasProblema };
}

@Injectable()
export class IdempotenciaV2Service {
  constructor(@InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource) {}

  async ejecutar<P = undefined>(
    clave: string,
    operacion: string,
    huella: string,
    ahora: Date,
    procesar: (manager: EntityManager, preparado: P) => Promise<RespuestaIdempotente>,
    preparar?: () => Promise<P>,
  ): Promise<RespuestaIdempotente> {
    try {
      await this.adquirir(clave, operacion, huella, ahora);
    } catch (e) {
      if (e instanceof RespuestaRepetida) return e.aRespuesta();
      throw e;
    }

    try {
      const preparado = preparar ? await preparar() : (undefined as P);
      return await this.dataSource.transaction(async (manager) => {
        const respuesta = await procesar(manager, preparado);
        await manager.update(IdempotenciaV2, { clave }, {
          estado: 'COMPLETADA',
          statusCode: respuesta.status,
          respuesta: respuesta.cuerpo,
          cabeceras: respuesta.cabeceras ?? null,
          actualizadaEn: new Date(),
        });
        return respuesta;
      });
    } catch (error) {
      if (error instanceof ProblemaV2Exception && error.estado < 500) {
        // Respuesta de negocio definitiva (409 sin cupo, 422…): se guarda para que el reintento reciba la misma
        const guardado: ErrorGuardado = { error: { codigo: error.codigo, detalle: error.detalle, extras: error.extras } };
        await this.dataSource.getRepository(IdempotenciaV2).update({ clave }, {
          estado: 'COMPLETADA',
          statusCode: error.estado,
          respuesta: guardado as unknown as Record<string, unknown>,
          actualizadaEn: new Date(),
        });
      } else {
        // Error inesperado: se libera la clave para que el reintento vuelva a procesar
        await this.dataSource.getRepository(IdempotenciaV2).delete({ clave, estado: 'EN_CURSO' });
      }
      throw error;
    }
  }

  // Registra la clave como propia (EN_CURSO). Si ya existía, aplica la decisión: lanza el error que corresponde
  // o devuelve la respuesta guardada (como excepción RespuestaRepetida, para cortar el flujo normal).
  private async adquirir(clave: string, operacion: string, huella: string, ahora: Date): Promise<void> {
    const repo = this.dataSource.getRepository(IdempotenciaV2);
    for (let intento = 0; intento < 3; intento++) {
      const insertada = await this.dataSource.query(
        `INSERT INTO "reservas"."idempotencia_v2" ("clave", "operacion", "huella", "estado", "creadaEn", "actualizadaEn", "expiraEn")
         VALUES ($1, $2, $3, 'EN_CURSO', $4, $4, $5) ON CONFLICT ("clave") DO NOTHING RETURNING "clave"`,
        [clave, operacion, huella, ahora, new Date(ahora.getTime() + RETENCION_MS)],
      );
      if (insertada.length > 0) return;

      const fila = await repo.findOneBy({ clave });
      if (!fila) continue; // se borró entre medio: se intenta de nuevo
      switch (decidir(fila, operacion, huella, ahora)) {
        case 'REUTILIZADA':
          throw new ProblemaV2Exception(422, 'IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó con un cuerpo distinto. Genera una clave nueva.', {
            invalid_params: [{ name: 'Idempotency-Key', reason: 'ya se usó con otra petición' }],
          });
        case 'EN_CURSO':
          throw new ProblemaV2Exception(409, 'IDEMPOTENCY_IN_PROGRESS', 'La petición original con esta Idempotency-Key todavía se está procesando.', {
            retry_after_seconds: 1,
          });
        case 'REPETIR':
          throw new RespuestaRepetida(fila);
        case 'VENCIDA':
          await repo.delete({ clave, expiraEn: fila.expiraEn });
          continue;
        case 'RETOMAR': {
          const tomada = await repo.update({ clave, estado: 'EN_CURSO', actualizadaEn: fila.actualizadaEn }, { actualizadaEn: ahora });
          if (tomada.affected === 1) return;
          continue;
        }
      }
    }
    throw new ProblemaV2Exception(409, 'IDEMPOTENCY_IN_PROGRESS', 'La Idempotency-Key está en uso. Reintenta en un momento.', { retry_after_seconds: 1 });
  }
}

// La respuesta guardada de una clave COMPLETADA. Se lanza para cortar el procesamiento y el controlador la responde
// tal cual (o vuelve a lanzar el error guardado) con Idempotent-Replayed: true.
export class RespuestaRepetida extends Error {
  readonly repetida = true;
  constructor(readonly fila: IdempotenciaV2) {
    super('Respuesta idempotente repetida');
  }

  aRespuesta(): RespuestaIdempotente {
    const guardado = this.fila.respuesta as unknown as Partial<ErrorGuardado>;
    if (guardado?.error) {
      const error = new ProblemaV2Exception(this.fila.statusCode, guardado.error.codigo, guardado.error.detalle, guardado.error.extras ?? {});
      error.cabeceras['Idempotent-Replayed'] = 'true';
      throw error;
    }
    return { status: this.fila.statusCode, cuerpo: this.fila.respuesta, cabeceras: this.fila.cabeceras ?? undefined, repetida: true };
  }
}

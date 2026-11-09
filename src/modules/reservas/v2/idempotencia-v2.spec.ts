import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decidir, FilaIdempotencia, IdempotenciaV2Service, RespuestaIdempotente, RETENCION_MS, RETOMAR_TRAS_MS } from './idempotencia-v2';
import { noEncontrado, ProblemaV2Exception } from '../../comun/v2/problemas-v2';

const T0 = new Date('2026-11-01T15:00:00Z');
const despues = (ms: number) => new Date(T0.getTime() + ms);
const fila = (cambios: Partial<FilaIdempotencia> = {}): FilaIdempotencia => ({
  operacion: 'createOrder',
  huella: 'h1',
  estado: 'COMPLETADA',
  actualizadaEn: T0,
  expiraEn: despues(RETENCION_MS),
  ...cambios,
});

test('Reintento con el mismo cuerpo: repite la respuesta guardada', () => {
  assert.equal(decidir(fila(), 'createOrder', 'h1', despues(5_000)), 'REPETIR');
  assert.equal(decidir(fila(), 'createOrder', 'h1', despues(RETENCION_MS - 1)), 'REPETIR');
});

test('Misma clave con cuerpo distinto u otra operación: reutilizada (422)', () => {
  assert.equal(decidir(fila(), 'createOrder', 'h2', despues(1)), 'REUTILIZADA');
  assert.equal(decidir(fila(), 'cancelOrder:x', 'h1', despues(1)), 'REUTILIZADA');
  assert.equal(decidir(fila({ estado: 'EN_CURSO' }), 'createOrder', 'h2', despues(1)), 'REUTILIZADA');
});

test('Misma clave mientras la primera sigue en curso: 409', () => {
  assert.equal(decidir(fila({ estado: 'EN_CURSO' }), 'createOrder', 'h1', despues(100)), 'EN_CURSO');
  assert.equal(decidir(fila({ estado: 'EN_CURSO' }), 'createOrder', 'h1', despues(RETOMAR_TRAS_MS - 1)), 'EN_CURSO');
});

test('Una petición en curso abandonada (proceso caído) se puede retomar', () => {
  assert.equal(decidir(fila({ estado: 'EN_CURSO' }), 'createOrder', 'h1', despues(RETOMAR_TRAS_MS)), 'RETOMAR');
});

test('Pasadas 24 horas la clave vence y se puede usar de nuevo', () => {
  assert.equal(decidir(fila(), 'createOrder', 'h1', despues(RETENCION_MS)), 'VENCIDA');
  assert.equal(decidir(fila(), 'createOrder', 'otra', despues(RETENCION_MS + 1)), 'VENCIDA');
});

// ───── Fase 8.2: `preparar` (lecturas del catálogo) va después de tomar la clave y antes de abrir la transacción ─────

// Base simulada: lo justo para `ejecutar`. `guardada` = la fila que ya existe para la clave (null: la clave es nueva).
function baseSimulada(guardada: Record<string, unknown> | null) {
  const registro: string[] = [];
  const actualizaciones: Record<string, unknown>[] = [];
  let enTransaccion = false;
  const repo = {
    findOneBy: async () => guardada,
    update: async (_donde: unknown, cambios: Record<string, unknown>) => (actualizaciones.push(cambios), { affected: 1 }),
    delete: async () => (registro.push('liberar clave'), { affected: 1 }),
  };
  const dataSource = {
    query: async (sql: string) => (registro.push('adquirir'), guardada || !sql.includes('INSERT') ? [] : [{ clave: 'k' }]),
    getRepository: () => repo,
    transaction: async (fn: (manager: unknown) => Promise<unknown>) => {
      registro.push('abrir transacción');
      enTransaccion = true;
      try {
        return await fn({ update: async (_e: unknown, _d: unknown, cambios: Record<string, unknown>) => actualizaciones.push(cambios) });
      } finally {
        enTransaccion = false;
      }
    },
  };
  return { servicio: new IdempotenciaV2Service(dataSource as never), registro, actualizaciones, enTransaccion: () => enTransaccion };
}

const ORDEN_201 = { orderId: 'o-1', estado: 'CONFIRMED', alojamientoId: 'HTL-1' };

test('Repetir una orden ya creada después de dar de baja su alojamiento devuelve el 201 guardado, sin leer el catálogo', async () => {
  const base = baseSimulada({
    clave: 'k', operacion: 'createOrder', huella: 'h1', estado: 'COMPLETADA', statusCode: 201, respuesta: ORDEN_201,
    cabeceras: { Location: '/api/v2/alojamientos/orders/o-1' }, actualizadaEn: T0, expiraEn: despues(RETENCION_MS),
  });
  let leyoCatalogo = false;
  const respuesta = await base.servicio.ejecutar(
    'k', 'createOrder', 'h1', despues(60_000),
    async () => assert.fail('una repetición no procesa de nuevo'),
    // El alojamiento ya está de baja: si se leyera el catálogo, la respuesta sería un 404
    async () => { leyoCatalogo = true; throw noEncontrado("No existe el alojamiento 'HTL-1'."); },
  );
  assert.equal(leyoCatalogo, false);
  assert.deepEqual(respuesta, { status: 201, cuerpo: ORDEN_201, cabeceras: { Location: '/api/v2/alojamientos/orders/o-1' }, repetida: true });
  assert.deepEqual(base.registro, ['adquirir']);
});

test('La primera vez: toma la clave, prepara fuera de la transacción y procesa dentro con lo preparado', async () => {
  const base = baseSimulada(null);
  const respuesta = await base.servicio.ejecutar<{ alojamiento: string }>(
    'k', 'createOrder', 'h1', T0,
    async (_manager, preparado): Promise<RespuestaIdempotente> => {
      assert.equal(base.enTransaccion(), true);
      assert.deepEqual(preparado, { alojamiento: 'HTL-1' });
      return { status: 201, cuerpo: ORDEN_201 };
    },
    async () => {
      assert.equal(base.enTransaccion(), false, 'el catálogo no se lee dentro de la transacción');
      base.registro.push('preparar');
      return { alojamiento: 'HTL-1' };
    },
  );
  assert.equal(respuesta.status, 201);
  assert.deepEqual(base.registro, ['adquirir', 'preparar', 'abrir transacción']);
  assert.equal(base.actualizaciones.at(-1)?.estado, 'COMPLETADA');
});

test('Un 404 o un 403 de `preparar` se guarda como respuesta definitiva y no abre la transacción', async () => {
  const base = baseSimulada(null);
  await assert.rejects(
    base.servicio.ejecutar('k', 'cancelOrder:x', 'h1', T0, async () => assert.fail('no debe procesar'), async () => {
      throw noEncontrado("No existe la reserva 'x'.");
    }),
    (e: unknown) => e instanceof ProblemaV2Exception && e.estado === 404,
  );
  assert.deepEqual(base.registro, ['adquirir']);
  assert.equal(base.actualizaciones.at(-1)?.estado, 'COMPLETADA');
  assert.equal(base.actualizaciones.at(-1)?.statusCode, 404);
});

test('Un error inesperado de `preparar` libera la clave para que el reintento vuelva a procesar', async () => {
  const base = baseSimulada(null);
  await assert.rejects(base.servicio.ejecutar('k', 'createOrder', 'h1', T0, async () => assert.fail('no debe procesar'), async () => {
    throw new Error('el catálogo no contestó');
  }));
  assert.deepEqual(base.registro, ['adquirir', 'liberar clave']);
});

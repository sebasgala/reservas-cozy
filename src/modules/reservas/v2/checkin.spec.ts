import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkinCierraEn, checkinHabilitadoDesde, etiquetaHabitacion, evaluarVentanaCheckin, generarClaveDigital, mismoDocumento, nombrePublico, totalConsumosCentavos } from './checkin';
import { fechaGuayaquil, instanteGuayaquil, isoGuayaquil } from '../../comun/v2/reloj';

// Reloj controlado: cada caso fija el instante exacto. Guayaquil es UTC−5 sin horario de verano, así que las 14:00 locales
// son las 19:00 UTC; la zona del servidor (UTC en Render, otra en una laptop) no debe cambiar nada.
const v = { checkinFecha: '2026-11-01', checkoutFecha: '2026-11-05', earlyAutorizado: false, earlyDesde: null as Date | null };
const en = (iso: string) => new Date(iso);

// Mínimo de expect() sobre node:assert, para que las pruebas se lean igual que el contrato
const expect = (valor: unknown) => ({
  toBe: (esperado: unknown) => assert.equal(valor, esperado),
  toBeNull: () => assert.equal(valor, null),
  toMatch: (re: RegExp) => assert.match(String(valor), re),
  toBeLessThanOrEqual: (max: number) => assert.ok((valor as number) <= max, `${String(valor)} > ${max}`),
});

describe('check-in: solo desde las 14:00 de Guayaquil', () => {
  it('13:59:59.999 todavía no; a las 14:00:00.000 en punto sí', () => {
    const antes = evaluarVentanaCheckin(v, en('2026-11-01T13:59:59.999-05:00'));
    expect(antes.estado).toBe('AUN_NO');
    expect(evaluarVentanaCheckin(v, en('2026-11-01T14:00:00.000-05:00')).estado).toBe('ABIERTA');
    expect(evaluarVentanaCheckin(v, en('2026-11-01T14:00:00.001-05:00')).estado).toBe('ABIERTA');
  });

  it('el mismo instante se evalúa igual escrito en UTC (19:00Z son las 14:00 de Guayaquil)', () => {
    expect(evaluarVentanaCheckin(v, en('2026-11-01T18:59:59.999Z')).estado).toBe('AUN_NO');
    expect(evaluarVentanaCheckin(v, en('2026-11-01T19:00:00.000Z')).estado).toBe('ABIERTA');
  });

  it('las 14:00 de otra zona no cuentan: las 14:00 UTC son las 09:00 de Guayaquil', () => {
    expect(evaluarVentanaCheckin(v, en('2026-11-01T14:00:00.000Z')).estado).toBe('AUN_NO');
  });

  it('el día anterior y la mañana de la llegada están cerrados, con habilitadoDesde = 14:00-05:00', () => {
    for (const iso of ['2026-10-31T23:59:59-05:00', '2026-11-01T00:00:00-05:00', '2026-11-01T08:00:00-05:00']) {
      const r = evaluarVentanaCheckin(v, en(iso));
      expect(r.estado).toBe('AUN_NO');
      if (r.estado === 'AUN_NO') expect(isoGuayaquil(r.habilitadoDesde)).toBe('2026-11-01T14:00:00-05:00');
    }
  });

  it('abierta toda la estancia, hasta el final del día de salida', () => {
    expect(evaluarVentanaCheckin(v, en('2026-11-03T03:00:00-05:00')).estado).toBe('ABIERTA');
    expect(evaluarVentanaCheckin(v, en('2026-11-05T23:59:59.999-05:00')).estado).toBe('ABIERTA');
    const vencida = evaluarVentanaCheckin(v, en('2026-11-06T00:00:00.000-05:00'));
    expect(vencida.estado).toBe('VENCIDA');
    expect(checkinCierraEn('2026-11-05').toISOString()).toBe('2026-11-06T05:00:00.000Z');
  });
});

describe('early check-in', () => {
  const desde = en('2026-11-01T10:00:00-05:00');

  it('autorizado adelanta la hora de habilitación', () => {
    const e = { ...v, earlyAutorizado: true, earlyDesde: desde };
    expect(checkinHabilitadoDesde(e).toISOString()).toBe(desde.toISOString());
    expect(evaluarVentanaCheckin(e, en('2026-11-01T09:59:59.999-05:00')).estado).toBe('AUN_NO');
    expect(evaluarVentanaCheckin(e, en('2026-11-01T10:00:00.000-05:00')).estado).toBe('ABIERTA');
  });

  it('sin autorización la hora de early no cuenta (el huésped no puede fijarla)', () => {
    expect(evaluarVentanaCheckin({ ...v, earlyAutorizado: false, earlyDesde: desde }, en('2026-11-01T10:00:00-05:00')).estado).toBe('AUN_NO');
  });

  it('una hora de early posterior a las 14:00 no atrasa el check-in', () => {
    const tarde = en('2026-11-01T18:00:00-05:00');
    expect(checkinHabilitadoDesde({ ...v, earlyAutorizado: true, earlyDesde: tarde }).toISOString()).toBe(instanteGuayaquil('2026-11-01', '14:00').toISOString());
  });
});

describe('apoyo de la estancia', () => {
  it('fechaGuayaquil cambia de día a las 05:00 UTC, no a las 00:00 UTC', () => {
    expect(fechaGuayaquil(en('2026-11-01T04:59:59Z'))).toBe('2026-10-31');
    expect(fechaGuayaquil(en('2026-11-01T05:00:00Z'))).toBe('2026-11-01');
  });

  it('el documento se compara sin mayúsculas ni espacios, tolera números y guiones, y una reserva sin documento nunca coincide', () => {
    expect(mismoDocumento(' ab123456 ', 'AB123456')).toBe(true);
    expect(mismoDocumento('1712345675', '1712345676')).toBe(false);
    expect(mismoDocumento('1712345675', undefined)).toBe(false);
    expect(mismoDocumento('1712345675', '')).toBe(false);
    expect(mismoDocumento('1712345675', 1712345675)).toBe(true);
    expect(mismoDocumento(1712345675, '1712345675')).toBe(true);
    expect(mismoDocumento('171234567-5', '1712345675')).toBe(true);
    expect(mismoDocumento('1712345675', '171234567-5')).toBe(true);
  });

  it('el nombre público es "Nombre I."', () => {
    expect(nombrePublico('María Fernanda Pérez Mora')).toBe('María M.');
    expect(nombrePublico('Ana Ruiz')).toBe('Ana R.');
    expect(nombrePublico('Ana')).toBe('Ana');
    expect(nombrePublico('   ')).toBe('Huésped');
  });

  it('la clave digital tiene el formato del contrato y la habitación es estable para la misma reserva', () => {
    expect(generarClaveDigital()).toMatch(/^PIN-\d{6}#$/);
    const id = '0b5f9d7e-2c11-4f43-8f1a-5d7c3a2e9b10';
    expect(etiquetaHabitacion('Suite Deluxe', id)).toBe(etiquetaHabitacion('Suite Deluxe', id));
    expect(etiquetaHabitacion('Suite Deluxe', id)).toMatch(/^Suite Deluxe - Hab\. [1-9]\d{2}$/);
    expect(etiquetaHabitacion('x'.repeat(200), id).length).toBeLessThanOrEqual(100);
  });

  it('los consumos se suman en centavos exactos y un total desbordado se detecta', () => {
    expect(totalConsumosCentavos([])).toBe(0);
    expect(totalConsumosCentavos([{ item: 'Agua', cantidad: 2, precio: '3.50' }, { item: 'Snack', precio: '0.10' }])).toBe(710);
    expect(totalConsumosCentavos([{ item: 'Oro', cantidad: 100, precio: '999999999.99' }])).toBeNull();
  });
});

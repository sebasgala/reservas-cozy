import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ProblemaV2Exception } from '../../comun/v2/problemas-v2';
import { aceptaPaquete, AcuerdoPromociones, descuentoEnCentavos, normalizarDestino, validarAcuerdoNuevo, validarPaqueteContraAcuerdo } from './promociones';

const vigente: AcuerdoPromociones = { permitePromociones: true, porcentajeMaximo: 15, destinos: ['Quito', 'Baños'], vigenciaDesde: '2026-10-01', vigenciaHasta: '2027-12-31' };
const paquete = (descuentoPorcentaje: number) => ({ descuentoPorcentaje, descuentoMonto: '0.00' });
const hoy = '2026-11-01';

const expect = (valor: unknown) => ({ toBe: (esperado: unknown) => assert.equal(valor, esperado) });

// El código del problema que lanza la validación (o 'OK' si pasa)
function resultado(f: () => void): string {
  try {
    f();
    return 'OK';
  } catch (e) {
    return e instanceof ProblemaV2Exception ? `${e.estado} ${e.codigo}` : `otro: ${e}`;
  }
}

describe('promociones: paquete contra el acuerdo B2B', () => {
  it('dentro del acuerdo pasa, también justo en el máximo', () => {
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(10), 'Quito', hoy))).toBe('OK');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(15), 'Quito', hoy))).toBe('OK');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(15.0), 'Quito', hoy))).toBe('OK');
  });

  it('sobre el máximo pactado: 422 DISCOUNT_EXCEEDS_CONTRACT (15.01 ya es demasiado)', () => {
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(15.01), 'Quito', hoy))).toBe('422 DISCOUNT_EXCEEDS_CONTRACT');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(20), 'Quito', hoy))).toBe('422 DISCOUNT_EXCEEDS_CONTRACT');
  });

  it('sin acuerdo formalizado o con permite_promociones=false: 422 PROMOTIONS_NOT_ALLOWED', () => {
    expect(resultado(() => validarPaqueteContraAcuerdo(null, paquete(0), 'Quito', hoy))).toBe('422 PROMOTIONS_NOT_ALLOWED');
    expect(resultado(() => validarPaqueteContraAcuerdo({ ...vigente, permitePromociones: false, porcentajeMaximo: 0 }, paquete(0), 'Quito', hoy))).toBe('422 PROMOTIONS_NOT_ALLOWED');
  });

  it('vigencia: el último día vale, el siguiente no; antes del inicio tampoco', () => {
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), 'Quito', '2027-12-31'))).toBe('OK');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), 'Quito', '2028-01-01'))).toBe('422 PROMOTIONS_NOT_ALLOWED');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), 'Quito', '2026-09-30'))).toBe('422 PROMOTIONS_NOT_ALLOWED');
    expect(resultado(() => validarPaqueteContraAcuerdo({ ...vigente, vigenciaHasta: null }, paquete(5), 'Quito', '2040-01-01'))).toBe('OK');
  });

  it('destino: sin importar mayúsculas ni acentos; fuera de la lista o sin ciudad se rechaza; lista vacía = todos', () => {
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), 'BANOS', hoy))).toBe('OK');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), 'Cuenca', hoy))).toBe('422 PROMOTIONS_NOT_ALLOWED');
    expect(resultado(() => validarPaqueteContraAcuerdo(vigente, paquete(5), null, hoy))).toBe('422 PROMOTIONS_NOT_ALLOWED');
    expect(resultado(() => validarPaqueteContraAcuerdo({ ...vigente, destinos: [] }, paquete(5), 'Cuenca', hoy))).toBe('OK');
    expect(normalizarDestino(' Galápagos ')).toBe('galapagos');
  });
});

describe('promociones: permitePaquete del catálogo usa la misma regla que la compra', () => {
  it('sin acuerdo, con permite_promociones=false o fuera de vigencia, ningún alojamiento acepta paquetes', () => {
    expect(aceptaPaquete(null, 'Quito', hoy)).toBe(false);
    expect(aceptaPaquete({ ...vigente, permitePromociones: false, porcentajeMaximo: 0 }, 'Quito', hoy)).toBe(false);
    expect(aceptaPaquete(vigente, 'Quito', '2026-09-30')).toBe(false);
    expect(aceptaPaquete(vigente, 'Quito', '2028-01-01')).toBe(false);
  });

  it('vigente: acepta el último día y solo en los destinos habilitados (sin acentos ni mayúsculas); lista vacía = todos', () => {
    expect(aceptaPaquete(vigente, 'Quito', '2027-12-31')).toBe(true);
    expect(aceptaPaquete(vigente, 'BANOS', hoy)).toBe(true);
    expect(aceptaPaquete(vigente, 'Cuenca', hoy)).toBe(false);
    expect(aceptaPaquete(vigente, null, hoy)).toBe(false);
    expect(aceptaPaquete({ ...vigente, destinos: [] }, 'Cuenca', hoy)).toBe(true);
    expect(aceptaPaquete({ ...vigente, destinos: [] }, null, hoy)).toBe(true);
  });

  it('coincide con la compra: donde el catálogo dice sí, la compra no da PROMOTIONS_NOT_ALLOWED, y viceversa', () => {
    const casos: [AcuerdoPromociones | null, string | null, string][] = [
      [null, 'Quito', hoy],
      [vigente, 'Quito', hoy],
      [vigente, 'Cuenca', hoy],
      [vigente, 'Quito', '2028-01-01'],
      [{ ...vigente, destinos: [] }, null, hoy],
      [{ ...vigente, permitePromociones: false, porcentajeMaximo: 0 }, 'Quito', hoy],
    ];
    for (const [acuerdo, destino, dia] of casos) {
      const compra = resultado(() => validarPaqueteContraAcuerdo(acuerdo, paquete(0), destino, dia));
      expect(aceptaPaquete(acuerdo, destino, dia)).toBe(compra === 'OK');
    }
  });
});

describe('promociones: alta del acuerdo (PUT)', () => {
  it('permite_promociones=false exige porcentaje 0', () => {
    expect(resultado(() => validarAcuerdoNuevo(false, 0, undefined, hoy))).toBe('OK');
    expect(resultado(() => validarAcuerdoNuevo(false, 10, undefined, hoy))).toBe('422 VALIDATION_FAILED');
    expect(resultado(() => validarAcuerdoNuevo(true, 10, undefined, hoy))).toBe('OK');
  });

  it('vigencia_hasta no puede estar vencida (hoy sí vale)', () => {
    expect(resultado(() => validarAcuerdoNuevo(true, 10, hoy, hoy))).toBe('OK');
    expect(resultado(() => validarAcuerdoNuevo(true, 10, '2026-10-31', hoy))).toBe('422 VALIDATION_FAILED');
  });
});

describe('promociones: descuentoMonto = round_half_up(subtotal × porcentaje / 100)', () => {
  it('cálculo exacto en centavos, con el medio hacia arriba', () => {
    expect(descuentoEnCentavos(48000, 10)).toBe(4800); // 480.00 → 48.00
    expect(descuentoEnCentavos(10050, 10)).toBe(1005); // 100.50 → 10.05
    expect(descuentoEnCentavos(10005, 10)).toBe(1001); // 100.05 × 10 % = 10.005 → 10.01
    expect(descuentoEnCentavos(12345, 12.5)).toBe(1543); // 123.45 × 12.5 % = 15.43125
    expect(descuentoEnCentavos(10000, 0)).toBe(0);
  });
});

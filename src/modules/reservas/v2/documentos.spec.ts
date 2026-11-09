import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cedulaValida, motivoDocumentoInvalido } from './documentos';

test('Cédula: módulo 10 (ejemplo del contrato 1712345675)', () => {
  assert.equal(cedulaValida('1712345675'), true);
  assert.equal(cedulaValida('1712345676'), false); // verificador cambiado
  assert.equal(cedulaValida('0926687856'), true);
  assert.equal(cedulaValida('2512345678'), false); // provincia 25 no existe
  assert.equal(cedulaValida('1762345678'), false); // tercer dígito 6
  assert.equal(cedulaValida('171234567'), false); // 9 dígitos
  assert.equal(cedulaValida('17123456a5'), false);
});

test('Motivos de documento inválido por tipo', () => {
  assert.equal(motivoDocumentoInvalido('CEDULA', '1712345675'), null);
  assert.match(motivoDocumentoInvalido('CEDULA', '1712345676') ?? '', /módulo 10/);
  assert.equal(motivoDocumentoInvalido('RUC', '1712345675001'), null);
  assert.match(motivoDocumentoInvalido('RUC', '1712345675000') ?? '', /000/);
  assert.match(motivoDocumentoInvalido('RUC', '171234567500') ?? '', /13 dígitos/);
  assert.equal(motivoDocumentoInvalido('PASAPORTE', 'AB123456'), null);
  assert.match(motivoDocumentoInvalido('PASAPORTE', 'ab123456') ?? '', /mayúsculas/);
  assert.match(motivoDocumentoInvalido('PASAPORTE', 'AB12') ?? '', /6 a 12/);
});

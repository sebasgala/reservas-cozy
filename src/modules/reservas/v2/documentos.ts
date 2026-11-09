// Documento del titular (contrato v2 §4): CEDULA = 10 dígitos + módulo 10; RUC = 13 dígitos; PASAPORTE = 6–12
// alfanuméricos en mayúsculas. Si no cumple => 422 INVALID_DOCUMENT.

export type TipoDocumento = 'CEDULA' | 'PASAPORTE' | 'RUC';

// Provincias del Ecuador (01–24) y 30 (ecuatorianos registrados en el exterior)
const provinciaValida = (dos: string) => {
  const n = Number(dos);
  return (n >= 1 && n <= 24) || n === 30;
};

// Cédula ecuatoriana: provincia válida, tercer dígito < 6 y dígito verificador por módulo 10
// (coeficientes 2,1,2,1,… sobre los 9 primeros; si un producto pasa de 9 se le resta 9).
export function cedulaValida(cedula: string): boolean {
  if (!/^[0-9]{10}$/.test(cedula)) return false;
  if (!provinciaValida(cedula.slice(0, 2)) || Number(cedula[2]) >= 6) return false;
  const suma = [...cedula.slice(0, 9)].reduce((s, d, i) => {
    const p = Number(d) * (i % 2 === 0 ? 2 : 1);
    return s + (p > 9 ? p - 9 : p);
  }, 0);
  return (10 - (suma % 10)) % 10 === Number(cedula[9]);
}

// Motivo por el que el documento no sirve, o null si es válido
export function motivoDocumentoInvalido(tipo: TipoDocumento, identificacion: string): string | null {
  switch (tipo) {
    case 'CEDULA':
      if (!/^[0-9]{10}$/.test(identificacion)) return 'la cédula debe tener 10 dígitos';
      return cedulaValida(identificacion) ? null : 'la cédula no supera la verificación módulo 10';
    case 'RUC':
      if (!/^[0-9]{13}$/.test(identificacion)) return 'el RUC debe tener 13 dígitos';
      if (!provinciaValida(identificacion.slice(0, 2))) return 'el RUC no empieza con un código de provincia válido';
      return identificacion.endsWith('000') ? 'el RUC no puede terminar en 000 (número de establecimiento)' : null;
    case 'PASAPORTE':
      return /^[A-Z0-9]{6,12}$/.test(identificacion) ? null : 'el pasaporte debe tener 6 a 12 letras mayúsculas o dígitos';
    default:
      return 'tipo de documento desconocido';
  }
}

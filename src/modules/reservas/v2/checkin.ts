import { randomInt } from 'crypto';
import { moneyACentavos } from '../../comun/v2/dinero';
import { instanteGuayaquil } from '../../comun/v2/reloj';

// Reglas de la estancia del contrato v2 (§4): funciones puras, sin base de datos ni reloj propio (reciben `ahora`), para
// probarlas con un reloj controlado.
//
//   Check-in   desde las 14:00 (Guayaquil) del día checkinFecha y hasta el final del día checkoutFecha.
//              Excepción: early check-in, que fija solo un administrador (nunca el huésped).
//   Check-out  solo desde CHECKED_IN.

export const HORA_CHECKIN = '14:00';
const UN_DIA_MS = 86_400_000;

export interface VentanaCheckin {
  checkinFecha: string;
  checkoutFecha: string;
  earlyAutorizado: boolean;
  // Instante desde el cual el administrador habilitó el check-in (solo cuenta si earlyAutorizado)
  earlyDesde: Date | null;
}

// Instante desde el cual se puede hacer el check-in. El early check-in solo adelanta: si el administrador pone una hora
// posterior a las 14:00, vale la de las 14:00.
export function checkinHabilitadoDesde(v: VentanaCheckin): Date {
  const base = instanteGuayaquil(v.checkinFecha, HORA_CHECKIN);
  if (!v.earlyAutorizado || !v.earlyDesde) return base;
  return v.earlyDesde.getTime() < base.getTime() ? v.earlyDesde : base;
}

// Primer instante en que ya NO se puede hacer el check-in: el día siguiente al checkoutFecha, a las 00:00 de Guayaquil
export const checkinCierraEn = (checkoutFecha: string): Date => new Date(instanteGuayaquil(checkoutFecha, '00:00').getTime() + UN_DIA_MS);

export type ResultadoVentana = { estado: 'ABIERTA' } | { estado: 'AUN_NO'; habilitadoDesde: Date } | { estado: 'VENCIDA'; cerroEn: Date };

// A las 14:00:00.000 en punto ya está abierta; un milisegundo antes, no.
export function evaluarVentanaCheckin(v: VentanaCheckin, ahora: Date): ResultadoVentana {
  const desde = checkinHabilitadoDesde(v);
  if (ahora.getTime() < desde.getTime()) return { estado: 'AUN_NO', habilitadoDesde: desde };
  const cierre = checkinCierraEn(v.checkoutFecha);
  if (ahora.getTime() >= cierre.getTime()) return { estado: 'VENCIDA', cerroEn: cierre };
  return { estado: 'ABIERTA' };
}

// Mayúsculas y sin espacios: el huésped puede escribir el pasaporte en minúsculas
export const normalizarDocumento = (documento: string | undefined | null): string => (documento ?? '').trim().toUpperCase();

export const mismoDocumento = (declarado: string, registrado: string | undefined | null): boolean => {
  const esperado = normalizarDocumento(registrado);
  return esperado.length > 0 && normalizarDocumento(declarado) === esperado;
};

// "Nombre I.": lo único del autor de una reseña que sale en público
export function nombrePublico(nombreCompleto: string): string {
  const partes = nombreCompleto.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'Huésped';
  if (partes.length === 1) return partes[0].slice(0, 98);
  return `${partes[0].slice(0, 90)} ${partes[partes.length - 1][0].toUpperCase()}.`;
}

// PIN de la puerta. Se simula: no hay una cerradura real detrás. 6 dígitos con el formato del contrato ("PIN-9812#").
export const generarClaveDigital = (): string => `PIN-${String(randomInt(0, 1_000_000)).padStart(6, '0')}#`;

// Etiqueta de la habitación asignada. No existe un inventario de habitaciones físicas (el modelo vende por tipo), así que el
// número se deriva del id de la reserva: el mismo número siempre para la misma reserva.
export function etiquetaHabitacion(nombreTipo: string, ordenId: string): string {
  const semilla = parseInt(ordenId.replace(/-/g, '').slice(0, 8), 16);
  const piso = (semilla % 9) + 1;
  const numero = ((Math.floor(semilla / 9) % 20) + 1).toString().padStart(2, '0');
  return `${nombreTipo.slice(0, 80)} - Hab. ${piso}${numero}`;
}

export interface ConsumoMinibar {
  item: string;
  cantidad?: number;
  precio: string;
}

export const MAX_CONSUMOS_CENTAVOS = 99_999_999_999;

// Total de consumos en centavos, o null si no cabe en un Money del contrato
export function totalConsumosCentavos(consumos: ConsumoMinibar[]): number | null {
  let total = 0;
  for (const c of consumos) total += (c.cantidad ?? 1) * moneyACentavos(c.precio);
  return total > MAX_CONSUMOS_CENTAVOS ? null : total;
}

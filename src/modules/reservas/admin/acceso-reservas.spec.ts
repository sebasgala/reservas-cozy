import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { EstadoUsuario, RolUsuario } from '../../usuarios/entities/usuario.entity';
import { SesionJwt } from '../../usuarios/seguridad/seguridad.tipos';
import { AprobarCheckinDto } from '../dto/admin/recepcion.dto';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { AccesoReservasService } from './acceso-reservas.service';
import { RecepcionService } from './recepcion.service';

// Bloque R (R3, R6 a R9): una cuenta del alojamiento A no ve ni modifica reservas del alojamiento B; el check-in de mostrador
// respeta la ventana de las 14:00 (Guayaquil) y el documento del titular; cada cambio deja su fila de auditoría local.

const ORDEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HAB_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HAB_A2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HAB_A3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RECEP_A = '33333333-3333-4333-8333-333333333333';
const ADMIN_LEGADO = '44444444-4444-4444-8444-444444444444';
const sesion = (rol: RolUsuario, alojamientoId: number | null, id = RECEP_A): SesionJwt => ({ id, rol, estado: EstadoUsuario.ACTIVO, alojamientoId });

const LLEGADA = '2026-11-20';
const ANTES_14 = new Date('2026-11-20T13:59:59.999-05:00');
const DESDE_14 = new Date('2026-11-20T14:00:00.000-05:00');

const orden = (id: string, alojamientoId: number, extra: Partial<Orden> = {}): Orden =>
  ({
    id,
    alojamientoId,
    locator: 'QA' + id.slice(0, 6).toUpperCase(),
    status: OrdenStatus.CONFIRMED,
    habitacionId: HAB_A,
    habitacionNombre: 'QA-Suite',
    alojamientoNombre: 'QA-Hotel A',
    habitacionAsignada: null,
    habitacionFisicaId: null,
    checkInEn: null,
    checkin: LLEGADA,
    checkout: '2026-11-22',
    habitacionesReservadas: 1,
    earlyCheckinAutorizado: false,
    earlyCheckinDesde: null,
    peticionesEspeciales: null,
    huespedTitular: { nombreCompleto: 'QA-Titular', identificacion: '1712345675', tipoDocumento: 'CEDULA', email: 'qa@cozy.test' },
    guests: { number_of_adults: 2, children: [], number_of_rooms: 1 },
    ...extra,
  }) as Orden;

const formulario = (extra: Partial<AprobarCheckinDto> = {}): AprobarCheckinDto => ({
  documentoPresentado: '1712345675',
  huespedesPresentes: 2,
  codigoRecepcionista: 'QA-REC-01',
  documentoVerificadoFisicamente: true,
  ...extra,
});

const estadoHttp = async (f: () => Promise<unknown>): Promise<number | string> => {
  try {
    await f();
    return 'OK';
  } catch (e) {
    return e instanceof HttpException ? e.getStatus() : `otro: ${e}`;
  }
};
const codigoDe = async (f: () => Promise<unknown>): Promise<string> => {
  try {
    await f();
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? (e instanceof HttpException ? String(e.getStatus()) : `otro: ${e}`);
  }
};

function entorno() {
  const ordenes = new Map<string, Orden>([
    [ORDEN_A, orden(ORDEN_A, 1)],
    [ORDEN_B, orden(ORDEN_B, 2)],
  ]);
  const auditoria: Record<string, unknown>[] = [];
  const repo = { findOneBy: async ({ id }: { id: string }) => ordenes.get(id) ?? null };
  // El catálogo solo se consulta por propietario para las cuentas anteriores al Bloque R (sin alojamiento en el token)
  const catalogo = {
    alojamientoPorId: async (id: number) => ({ id, nombre: `QA-Hotel ${id}`, codigo: `HTL-${id}`, propietarioId: id === 1 ? ADMIN_LEGADO : 'otro' }),
    habitaciones: async ({ ids }: { ids?: string[] }) => [{ id: HAB_A, nombre: 'QA-Suite', tipo: 'suite' }].filter((h) => !ids || ids.includes(h.id)),
  };
  // HAB_A2 tiene cupo en las fechas; HAB_A3 no (no aparece)
  const disponibilidad = { habitacionesDisponibles: async () => [{ id: HAB_A2, nombre: 'QA-Doble', tipo: 'doble' }] };
  const acceso = new AccesoReservasService(repo as never, catalogo as never);
  const manager = {
    getRepository: () => ({ createQueryBuilder: () => ({ setLock: () => ({ where: (_s: string, { id }: { id: string }) => ({ getOne: async () => ordenes.get(id) }) }) }) }),
    save: async (o: Orden) => o,
    insert: async (_e: unknown, fila: Record<string, unknown>) => void auditoria.push(fila),
  };
  const dataSource = { transaction: async (f: (m: typeof manager) => Promise<unknown>) => f(manager), getRepository: () => ({ find: async () => auditoria }) };
  const recepcion = new RecepcionService(dataSource as never, acceso, catalogo as never, disponibilidad as never);
  return { acceso, recepcion, ordenes, auditoria };
}

describe('Bloque R: aislamiento de reservas por alojamiento (R3)', () => {
  it('recepción y administrador del alojamiento A no ven ni modifican la reserva del alojamiento B (404)', async () => {
    const e = entorno();
    for (const rol of [RolUsuario.RECEPCION, RolUsuario.ADMINISTRADOR]) {
      const yo = sesion(rol, 1);
      assert.equal((await e.acceso.orden(ORDEN_A, yo)).id, ORDEN_A);
      assert.equal(await estadoHttp(() => e.acceso.orden(ORDEN_B, yo)), 404);
      assert.equal(await estadoHttp(() => e.recepcion.aprobarCheckin(ORDEN_B, formulario(), yo, DESDE_14)), 404);
      assert.equal(await estadoHttp(() => e.recepcion.reasignarHabitacion(ORDEN_B, { habitacionId: HAB_A2 }, yo)), 404);
      assert.equal(await estadoHttp(() => e.recepcion.cambiarHuespedes(ORDEN_B, { adultos: 1 }, yo)), 404);
      assert.equal(await estadoHttp(() => e.recepcion.cambiarObservaciones(ORDEN_B, { observaciones: 'x' }, yo)), 404);
      assert.equal(await estadoHttp(() => e.recepcion.habitacionesReasignables(ORDEN_B, yo)), 404);
    }
    assert.equal(e.ordenes.get(ORDEN_B).status, OrdenStatus.CONFIRMED, 'la reserva B no cambió');
    assert.equal(e.auditoria.length, 0);
  });

  it('el filtro de listados usa el alojamiento del token: pedir otro da 404; el superadmin elige cualquiera', () => {
    const e = entorno();
    assert.equal(e.acceso.alojamientoDelFiltro(sesion(RolUsuario.RECEPCION, 1), undefined), 1);
    assert.equal(e.acceso.alojamientoDelFiltro(sesion(RolUsuario.ADMINISTRADOR, 1), 1), 1);
    assert.throws(() => e.acceso.alojamientoDelFiltro(sesion(RolUsuario.ADMINISTRADOR, 1), 2), (err: HttpException) => err.getStatus() === 404);
    assert.equal(e.acceso.alojamientoDelFiltro(sesion(RolUsuario.SUPERADMIN, null), 2), 2);
    assert.equal(e.acceso.propietarioDelFiltro(sesion(RolUsuario.ADMINISTRADOR, 1)), undefined);
    assert.equal(e.acceso.propietarioDelFiltro(sesion(RolUsuario.ADMINISTRADOR, null, ADMIN_LEGADO)), ADMIN_LEGADO);
  });

  it('el superadmin ve todo y un administrador anterior al Bloque R sigue viendo por propietarioId', async () => {
    const e = entorno();
    assert.equal((await e.acceso.orden(ORDEN_B, sesion(RolUsuario.SUPERADMIN, null))).id, ORDEN_B);
    const legado = sesion(RolUsuario.ADMINISTRADOR, null, ADMIN_LEGADO);
    assert.equal((await e.acceso.orden(ORDEN_A, legado)).id, ORDEN_A);
    assert.equal(await estadoHttp(() => e.acceso.orden(ORDEN_B, legado)), 404);
    assert.equal(await estadoHttp(() => e.acceso.orden(ORDEN_A, sesion(RolUsuario.RECEPCION, null))), 404);
  });
});

describe('Bloque R: check-in de mostrador (R7 y R8)', () => {
  it('antes de las 14:00 de Guayaquil responde 409 CHECKIN_TIME_NOT_REACHED; a las 14:00 en punto se aprueba', async () => {
    const e = entorno();
    const yo = sesion(RolUsuario.RECEPCION, 1);
    assert.equal(await codigoDe(() => e.recepcion.aprobarCheckin(ORDEN_A, formulario(), yo, ANTES_14)), 'CHECKIN_TIME_NOT_REACHED');
    const r = await e.recepcion.aprobarCheckin(ORDEN_A, formulario(), yo, DESDE_14);
    assert.equal(r.estado, OrdenStatus.CHECKED_IN);
    assert.equal(r.habitacionAsignada, 'QA-Suite');
  });

  it('con early check-in autorizado por el administrador se aprueba antes de las 14:00; la recepción no puede autorizarlo', async () => {
    const e = entorno();
    const madrugada = new Date('2026-11-20T09:00:00-05:00');
    assert.equal(await estadoHttp(() => e.recepcion.autorizarEarlyCheckin(ORDEN_A, {}, sesion(RolUsuario.RECEPCION, 1), madrugada)), 403);
    const autorizada = await e.recepcion.autorizarEarlyCheckin(ORDEN_A, { desde: '2026-11-20T08:00:00-05:00', motivo: 'QA-vuelo temprano' }, sesion(RolUsuario.ADMINISTRADOR, 1), madrugada);
    assert.deepEqual(autorizada.earlyCheckin, { autorizado: true, desde: '2026-11-20T13:00:00.000Z' });
    assert.equal(autorizada.checkinHabilitadoDesde, '2026-11-20T13:00:00.000Z');
    assert.equal((await e.recepcion.aprobarCheckin(ORDEN_A, formulario(), sesion(RolUsuario.RECEPCION, 1), madrugada)).estado, OrdenStatus.CHECKED_IN);
  });

  it('el documento presentado debe coincidir con el del titular (400) y la auditoría guarda el documento enmascarado', async () => {
    const e = entorno();
    const yo = sesion(RolUsuario.RECEPCION, 1);
    assert.equal(await estadoHttp(() => e.recepcion.aprobarCheckin(ORDEN_A, formulario({ documentoPresentado: '1712345676' }), yo, DESDE_14)), 400);
    assert.equal(e.ordenes.get(ORDEN_A).status, OrdenStatus.CONFIRMED);
    await e.recepcion.aprobarCheckin(ORDEN_A, formulario({ observaciones: 'QA-llegó en taxi' }), yo, DESDE_14);
    const nuevos = e.auditoria[0].datosNuevos as Record<string, unknown>;
    assert.equal(e.auditoria[0].accion, 'CHECKIN_APROBADO');
    assert.equal(nuevos.documentoPresentado, '******5675');
    assert.equal(nuevos.documentoCoincide, true);
    assert.equal(nuevos.huespedesPresentes, 2);
    assert.equal(nuevos.codigoRecepcionista, 'QA-REC-01');
    assert.equal(nuevos.documentoVerificadoFisicamente, true);
    assert.equal(e.auditoria[0].motivo, 'QA-llegó en taxi');
  });

  it('reasignar solo a una habitación del alojamiento con cupo en las mismas fechas (409 ROOM_NOT_AVAILABLE si no)', async () => {
    const e = entorno();
    const yo = sesion(RolUsuario.RECEPCION, 1);
    const lista = await e.recepcion.habitacionesReasignables(ORDEN_A, yo);
    assert.deepEqual(lista.map((h) => [h.id, h.actual]), [[HAB_A, true], [HAB_A2, false]]);
    assert.equal(await codigoDe(() => e.recepcion.reasignarHabitacion(ORDEN_A, { habitacionId: HAB_A3 }, yo)), 'ROOM_NOT_AVAILABLE');
    const r = await e.recepcion.reasignarHabitacion(ORDEN_A, { habitacionId: HAB_A2, etiqueta: '204', motivo: 'QA-mantenimiento' }, yo);
    assert.equal(r.habitacionAsignada, 'QA-Doble - 204');
    assert.equal(r.habitacionId, HAB_A, 'el tipo vendido (contrato) no cambia');
    assert.deepEqual(e.auditoria[0].datosNuevos, { habitacionAsignada: 'QA-Doble - 204', habitacionId: HAB_A2 });
  });
});

describe('Bloque R: auditoría local de recepción (R9)', () => {
  it('huéspedes y observaciones dejan su fila con datos previos y nuevos; repetir sin cambios no escribe', async () => {
    const e = entorno();
    const yo = sesion(RolUsuario.RECEPCION, 1);
    await e.recepcion.cambiarHuespedes(ORDEN_A, { adultos: 3, ninos: [5] }, yo);
    await e.recepcion.cambiarHuespedes(ORDEN_A, { adultos: 3, ninos: [5] }, yo);
    await e.recepcion.cambiarObservaciones(ORDEN_A, { observaciones: 'QA-cuna' }, yo);
    assert.deepEqual(e.ordenes.get(ORDEN_A).guests, { number_of_adults: 3, children: [5], number_of_rooms: 1 });
    assert.deepEqual(
      e.auditoria.map((a) => [a.accion, a.alojamientoId, a.reservaId, a.usuarioId, a.rol]),
      [
        ['CAMBIO_GUEST_COUNT', 1, ORDEN_A, RECEP_A, 'recepcion'],
        ['CAMBIO_OBSERVACIONES', 1, ORDEN_A, RECEP_A, 'recepcion'],
      ],
    );
    assert.deepEqual(e.auditoria[0].datosPrevios, { number_of_adults: 2, children: [] });
    assert.deepEqual(e.auditoria[1].datosNuevos, { observaciones: 'QA-cuna' });
  });

  it('una reserva cancelada no admite operaciones de recepción (409)', async () => {
    const e = entorno();
    const yo = sesion(RolUsuario.RECEPCION, 1);
    e.ordenes.set(ORDEN_A, orden(ORDEN_A, 1, { status: OrdenStatus.CANCELLED }));
    assert.equal(await estadoHttp(() => e.recepcion.aprobarCheckin(ORDEN_A, formulario(), yo, DESDE_14)), 409);
    assert.equal(await estadoHttp(() => e.recepcion.cambiarHuespedes(ORDEN_A, { adultos: 2 }, yo)), 409);
    assert.equal(await estadoHttp(() => e.recepcion.reasignarHabitacion(ORDEN_A, { habitacionId: HAB_A2 }, yo)), 409);
    assert.equal(e.auditoria.length, 0);
  });
});

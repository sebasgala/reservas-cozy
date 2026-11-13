import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { AccesoReservasService } from '../admin/acceso-reservas.service';
import { RecepcionService } from '../admin/recepcion.service';
import { RolUsuario, UsuarioSesion } from '../../usuarios/usuarios.contrato';
import { BookingCheckinClient } from './booking-checkin.client';
import { EstanciaV2Service } from './estancia-v2.service';

describe('Ciclo completo de estados hacia Booking (Check-in -> Check-out -> Limpieza)', () => {
  it('emite los eventos del contrato y notifica a Booking en check-in, check-out y limpieza', async () => {
    const orden: Orden = Object.assign(new Orden(), {
      id: '11111111-1111-4111-8111-111111111111',
      locator: 'CP83XEYF',
      status: OrdenStatus.CONFIRMED,
      alojamientoId: 1,
      alojamientoCodigo: 'HTL-CARLOS-01',
      alojamientoNombre: 'Prueba Viernes Carlos Final',
      habitacionId: '22222222-2222-4222-8222-222222222222',
      habitacionCodigo: 'HAB-CARLOS',
      habitacionNombre: 'Habitación Prueba Viernes CARLOS',
      habitacionAsignada: null,
      habitacionFisicaId: null,
      checkin: '2026-11-15',
      checkout: '2026-11-16',
      habitacionesReservadas: 1,
      total: 94,
      currency: 'USD',
      clienteId: 'cli-123',
      customerFirstName: 'Juan',
      customerLastName: 'López',
      customerEmail: 'juanlopez@gmail.com',
      huespedTitular: { nombreCompleto: 'Juan López', email: 'juanlopez@gmail.com', tipoDocumento: 'CEDULA', identificacion: '1712345675' },
      guests: { number_of_adults: 2, children: [] },
      earlyCheckinAutorizado: false,
      earlyCheckinDesde: null,
      archivadaRecepcion: false,
      creadoEn: new Date('2026-11-13T10:00:00Z'),
    });

    const eventosEmitidos: Array<{ tipo: string; datos: Record<string, unknown> }> = [];
    const avisosStock: unknown[] = [];
    const llamadasBooking: Array<{ url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

    const manager = {
      getRepository: () => ({
        createQueryBuilder: () => ({
          setLock: () => ({
            where: () => ({
              getOne: async () => orden,
            }),
          }),
        }),
      }),
      save: async (o: Orden) => o,
      insert: async () => undefined,
    };

    const dataSource = {
      transaction: async <T>(fn: (m: typeof manager) => Promise<T>) => fn(manager),
    };

    const eventos = {
      emitir: async (_m: unknown, lista: Array<{ tipo: string; datos: Record<string, unknown> }>) => {
        eventosEmitidos.push(...lista);
      },
      emitirHabitacionLimpiaLista: async (_m: unknown, _sujeto: string, _alojamientoId: number, datos: Record<string, unknown>) => {
        eventosEmitidos.push({ tipo: 'habitacion.limpia.lista', datos });
      },
    };

    const bookingClient = new BookingCheckinClient('https://booking-prod.example.com', 'secret-booking-key');
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      llamadasBooking.push({
        url: String(url),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const originalNotificar = bookingClient.notificarCheckin.bind(bookingClient);
    bookingClient.notificarCheckin = (payload, correlacion) => originalNotificar(payload, correlacion, mockFetch);

    const catalogo = {
      alojamientoPorId: async (id: number) => ({ id, nombre: orden.alojamientoNombre, codigo: orden.alojamientoCodigo, propietarioId: 'admin-1' }),
      habitaciones: async () => [{ id: orden.habitacionId, nombre: orden.habitacionNombre, tipo: 'doble' }],
      habitacionPorId: async () => ({ id: orden.habitacionId, nombre: orden.habitacionNombre, codigo: orden.habitacionCodigo, alojamientoId: orden.alojamientoId }),
    };
    const acceso = new AccesoReservasService({ findOneBy: async () => orden } as never, catalogo as never);
    const fisicas = {
      verificaControlaLimpieza: async () => false,
      asignarYOcupar: async () => ({ id: 'hf-1' }),
      marcarSucia: async () => undefined,
      marcarLista: async () => undefined,
    };

    const recepcion = new RecepcionService(dataSource as never, acceso, catalogo as never, {} as never, fisicas as never, eventos as never, bookingClient);
    const estancia = new EstanciaV2Service(
      dataSource as never,
      {
        localizar: async () => orden,
        habitacionParaStock: async () => ({ id: orden.habitacionId, codigo: orden.habitacionCodigo, alojamientoCodigo: orden.alojamientoCodigo }),
      } as never,
      eventos as never,
      { avisarStockTrasCommit: async (aviso: unknown) => void avisosStock.push(aviso) } as never,
      fisicas as never,
      bookingClient,
    );

    const usuarioRecepcion: UsuarioSesion = { id: 'rec-1', rol: RolUsuario.RECEPCION, alojamientoId: 1 };

    // 1. Check-in en recepción
    const resCheckin = await recepcion.aprobarCheckin(
      orden.id,
      { documentoPresentado: '1712345675', huespedesPresentes: 2, codigoRecepcionista: 'REC-01', documentoVerificadoFisicamente: true },
      usuarioRecepcion,
      new Date('2026-11-15T19:00:00Z'),
    );
    assert.equal(resCheckin.estado, OrdenStatus.CHECKED_IN);
    assert.equal(resCheckin.titular.identificacion, '1712345675');

    assert.equal(eventosEmitidos.length, 1);
    assert.equal(eventosEmitidos[0].tipo, 'alojamiento.checkin.completado');
    assert.equal(eventosEmitidos[0].datos.estado, 'CHECKED_IN');
    assert.equal(eventosEmitidos[0].datos.external_order_id, 'ORD-HTL-CP83XEYF');

    assert.equal(llamadasBooking.length, 1);
    assert.equal(llamadasBooking[0].url, 'https://booking-prod.example.com/api/v2/reservas/ORD-HTL-CP83XEYF/checkin');
    assert.equal(llamadasBooking[0].headers['X-API-Key'], 'secret-booking-key');
    assert.equal(llamadasBooking[0].body.estado, 'CONFIRMADO_ASISTIDO');

    // 2. Check-out
    const resCheckout = await estancia.checkOut(
      orden.id,
      {},
      { via: 'usuario', usuarioId: 'rec-1', rol: 'ADMIN', alojamientoId: 1 },
      new Date('2026-11-16T15:00:00Z'),
      'corr-1',
    );
    assert.equal(resCheckout.estado, 'CHECKED_OUT');
    assert.equal(orden.status, OrdenStatus.POR_LIMPIAR);
    assert.equal(eventosEmitidos.length, 2);
    assert.equal(eventosEmitidos[1].tipo, 'alojamiento.checkout.completado');
    assert.equal(eventosEmitidos[1].datos.estado, 'CHECKED_OUT');
    assert.equal(eventosEmitidos[1].datos.external_order_id, 'ORD-HTL-CP83XEYF');
    assert.equal(avisosStock.length, 1, 'check-out dispara aviso de stock tras commit');

    // 3. Limpieza / liberación sin habitacionFisicaId (alojamiento sin habitaciones físicas)
    const resLimpieza = await recepcion.marcarHabitacionLista(orden.id, { notas: 'Limpia y verificada' }, usuarioRecepcion, new Date('2026-11-16T16:00:00Z'));
    assert.equal(resLimpieza.estado, OrdenStatus.LIMPIA_LISTA);
    assert.equal(resLimpieza.archivadaRecepcion, true);
    assert.equal(eventosEmitidos.length, 3);
    assert.equal(eventosEmitidos[2].tipo, 'habitacion.limpia.lista');
    assert.equal(eventosEmitidos[2].datos.habitacionFisicaId, null);
  });
});

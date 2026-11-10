import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BookingCheckinClient,
  construirCuerpoCheckinBooking,
  formatearFechaCheckinUtc,
  TEXTO_OBSERVACIONES_POR_DEFECTO,
  validarConfiguracionBooking,
} from './booking-checkin.client';
import { EstanciaV2Service } from './estancia-v2.service';
import { OrdenStatus } from '../entities/orden.entity';

describe('Paso 5: Cliente saliente de check-in hacia Booking', () => {
  // ───────────────────────── 1. Headers y Configuración ─────────────────────────
  describe('Headers y validación de variables de entorno', () => {
    it('en producción, si falta BOOKING_CHECKIN_KEY (o BOOKING_API_KEY) lanza error y no arranca', () => {
      assert.throws(
        () => validarConfiguracionBooking({ NODE_ENV: 'production', BOOKING_API_KEY: '', BOOKING_CHECKIN_KEY: '' }),
        /Configuración inválida en producción: falta la variable BOOKING_CHECKIN_KEY/,
      );
      assert.throws(
        () => validarConfiguracionBooking({ NODE_ENV: 'production' }),
        /Configuración inválida en producción: falta la variable BOOKING_CHECKIN_KEY/,
      );
    });

    it('en producción con BOOKING_CHECKIN_KEY o BOOKING_API_KEY configurada pasa la validación', () => {
      assert.doesNotThrow(() =>
        validarConfiguracionBooking({ NODE_ENV: 'production', BOOKING_CHECKIN_KEY: 'booking-secret-key-1234' }),
      );
      assert.doesNotThrow(() =>
        validarConfiguracionBooking({ NODE_ENV: 'production', BOOKING_API_KEY: 'booking-secret-key-1234' }),
      );
    });

    it('en desarrollo o test no exige BOOKING_API_KEY para arrancar', () => {
      assert.doesNotThrow(() => validarConfiguracionBooking({ NODE_ENV: 'test' }));
      assert.doesNotThrow(() => validarConfiguracionBooking({ NODE_ENV: 'development' }));
    });

    it('envía los headers Content-Type application/json y X-API-Key en la petición saliente', async () => {
      let headersRecibidos: Record<string, string> = {};
      let urlLlamada = '';

      const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urlLlamada = String(input);
        headersRecibidos = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;

      const cliente = new BookingCheckinClient('http://mock-booking.local', 'clave-secreta-xyz');
      const payload = construirCuerpoCheckinBooking({
        external_order_id: 'ORD-HTL-9981',
        client_id: 'c1234567-0000-0000-0000-000000000001',
        huespedes_reales: 2,
        admin_id: 'adm-001',
        fecha_checkin: new Date('2026-11-09T14:30:00-05:00'),
      });

      await cliente.notificarCheckin(payload, 'corr-test-123', mockFetch);

      assert.equal(urlLlamada, 'http://mock-booking.local/api/v2/reservas/ORD-HTL-9981/checkin');
      assert.equal(headersRecibidos['Content-Type'], 'application/json');
      assert.equal(headersRecibidos['X-API-Key'], 'clave-secreta-xyz');
      assert.equal(headersRecibidos['X-Correlation-ID'], 'corr-test-123');
    });
  });

  // ───────────────────────── 2. Formato de fecha con Z ─────────────────────────
  describe('Conversión de fecha_checkin a UTC con terminación Z', () => {
    it('convierte un objeto Date a ISO UTC terminado en Z', () => {
      const fecha = new Date('2026-11-09T19:30:00.000Z');
      const resultado = formatearFechaCheckinUtc(fecha);
      assert.ok(resultado.endsWith('Z'), `Debe terminar en Z: ${resultado}`);
      assert.equal(resultado, '2026-11-09T19:30:00.000Z');
    });

    it('convierte hora local de Guayaquil (UTC-5) a UTC con Z (14:30 Guayaquil = 19:30 UTC)', () => {
      const fechaGye = '2026-11-09T14:30:00-05:00';
      const resultado = formatearFechaCheckinUtc(fechaGye);
      assert.ok(resultado.endsWith('Z'), `Debe terminar en Z: ${resultado}`);
      assert.equal(resultado, '2026-11-09T19:30:00.000Z');
    });

    it('si viene string sin offset asume Guayaquil (UTC-5) y genera UTC terminado en Z', () => {
      const fechaSinOffset = '2026-11-09T14:30:00';
      const resultado = formatearFechaCheckinUtc(fechaSinOffset);
      assert.ok(resultado.endsWith('Z'), `Debe terminar en Z: ${resultado}`);
      assert.equal(resultado, '2026-11-09T19:30:00.000Z');
    });
  });

  // ───────────────────────── 3. Body y Observaciones por defecto ─────────────────────────
  describe('Construcción del body y texto de observaciones por defecto', () => {
    it('construye el body completo con todos los campos requeridos', () => {
      const payload = construirCuerpoCheckinBooking({
        external_order_id: 'ORD-HTL-4412',
        client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        huespedes_reales: 3,
        admin_id: 'recepcion-norte',
        fecha_checkin: '2026-11-09T14:00:00-05:00',
        observaciones: 'Huéspedes solicitaron almohadas adicionales.',
      });

      assert.deepEqual(payload, {
        external_order_id: 'ORD-HTL-4412',
        client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        estado: 'CONFIRMADO_ASISTIDO',
        huespedes_reales: 3,
        admin_id: 'recepcion-norte',
        fecha_checkin: '2026-11-09T19:00:00.000Z',
        observaciones: 'Huéspedes solicitaron almohadas adicionales.',
      });
    });

    it('asigna "Check-in confirmado localmente" si observaciones viene vacío, null o undefined', () => {
      const p1 = construirCuerpoCheckinBooking({
        external_order_id: 'ORD-HTL-1111',
        client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        huespedes_reales: 1,
        admin_id: 'admin',
        fecha_checkin: new Date(),
        observaciones: '',
      });
      assert.equal(p1.observaciones, TEXTO_OBSERVACIONES_POR_DEFECTO);

      const p2 = construirCuerpoCheckinBooking({
        external_order_id: 'ORD-HTL-1111',
        client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        huespedes_reales: 1,
        admin_id: 'admin',
        fecha_checkin: new Date(),
        observaciones: null,
      });
      assert.equal(p2.observaciones, TEXTO_OBSERVACIONES_POR_DEFECTO);

      const p3 = construirCuerpoCheckinBooking({
        external_order_id: 'ORD-HTL-1111',
        client_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        huespedes_reales: 1,
        admin_id: 'admin',
        fecha_checkin: new Date(),
        observaciones: '   ',
      });
      assert.equal(p3.observaciones, TEXTO_OBSERVACIONES_POR_DEFECTO);
    });
  });

  // ───────────────────────── 4. Reintentos y Fallo sin Revertir Local ─────────────────────────
  describe('Comportamiento ante error de Booking sin revertir check-in local', () => {
    it('cuando Booking responde con error 500, guarda el resultado y registra reintento pendiente', async () => {
      const mockFetch: typeof fetch = (async () => {
        return new Response(JSON.stringify({ detail: 'Booking internal error' }), {
          status: 500,
          statusText: 'Internal Server Error',
        });
      }) as unknown as typeof fetch;

      const cliente = new BookingCheckinClient('http://mock-booking.local', 'api-key-test');
      const payload = cliente.construirPayload({
        external_order_id: 'ORD-HTL-5000',
        client_id: 'c1234567-0000-0000-0000-000000000002',
        huespedes_reales: 2,
        admin_id: 'adm-01',
        fecha_checkin: new Date('2026-11-09T14:00:00-05:00'),
      });

      const res = await cliente.notificarCheckin(payload, null, mockFetch);
      assert.equal(res.exito, false);
      assert.equal(res.estadoHttp, 500);

      const guardado = await cliente.guardarResultado('orden-uuid-5000', payload, res);
      assert.equal(guardado.estado, 'PENDIENTE_REINTENTO');
      assert.equal(guardado.intentos, 1);
      assert.ok(guardado.proximoReintento !== undefined);

      const pendientes = cliente.obtenerReintentosPendientes();
      assert.equal(pendientes.length, 1);
      assert.equal(pendientes[0].ordenId, 'orden-uuid-5000');
    });

    it('en EstanciaV2Service, si Booking falla la reserva local queda CHECKED_IN y no se revierte', async () => {
      // Mock de orden existente en estado CONFIRMED
      const ordenMock: any = {
        id: 'ord-uuid-local-123',
        locator: '8842',
        status: OrdenStatus.CONFIRMED,
        alojamientoId: 10,
        alojamientoCodigo: 'HTL-UIO-01',
        habitacionCodigo: 'STD',
        habitacionNombre: 'Habitación Estándar',
        checkin: '2026-11-09',
        checkout: '2026-11-12',
        huespedTitular: { identificacion: '1712345678' },
        guests: { number_of_adults: 2, children: [4] },
        clienteId: 'cli-uuid-999',
        earlyCheckinAutorizado: false,
      };

      // Mock de DataSource de TypeORM que simula transacción exitosa
      const managerMock: any = {
        save: async (o: any) => {
          Object.assign(ordenMock, o);
          return ordenMock;
        },
        getRepository: () => ({
          createQueryBuilder: () => ({
            setLock: () => ({
              where: () => ({
                getOne: async () => ordenMock,
              }),
            }),
          }),
        }),
      };

      const dataSourceMock: any = {
        transaction: async (cb: (m: any) => Promise<any>) => cb(managerMock),
      };

      const ordenesServiceMock: any = {
        localizar: async () => ordenMock,
      };

      const eventosServiceMock: any = {
        emitir: async () => {},
      };

      const sagasServiceMock: any = {};

      // Mock fetch que falla con 503 Service Unavailable hacia Booking
      const mockFetchFallido: typeof fetch = (async () => {
        return new Response(JSON.stringify({ detail: 'Booking temporalmente no disponible' }), {
          status: 503,
          statusText: 'Service Unavailable',
        });
      }) as unknown as typeof fetch;

      let mockFetchActual = mockFetchFallido;
      const bookingClient = new BookingCheckinClient('http://mock-booking.local', 'test-key');
      const notificarOriginal = bookingClient.notificarCheckin.bind(bookingClient);
      bookingClient.notificarCheckin = (p, c, f) => notificarOriginal(p, c, f || mockFetchActual);

      const estanciaService = new EstanciaV2Service(
        dataSourceMock,
        ordenesServiceMock,
        eventosServiceMock,
        sagasServiceMock,
        bookingClient,
      );

      // Instante dentro de la ventana de check-in (14:30 de Guayaquil = 19:30 UTC)
      const ahora = new Date('2026-11-09T19:30:00.000Z');

      const resultado = await estanciaService.checkIn(
        'ORD-HTL-8842',
        { titularIdentificacion: '1712345678' },
        { rol: 'ADMIN', usuarioId: 'admin-recepcionista', via: 'usuario' },
        ahora,
        'corr-error-booking-test',
      );

      // Verificamos que el check-in local se completó exitosamente
      assert.equal(resultado.estado, 'CHECKED_IN');
      assert.equal(resultado.reservaId, 'ord-uuid-local-123');
      assert.ok(resultado.claveAccesoDigital.startsWith('PIN-'));
      assert.equal(ordenMock.status, OrdenStatus.CHECKED_IN);

      // Verificamos que se guardó el resultado del fallo y quedó en reintento pendiente
      const registro = bookingClient.obtenerRegistro('ord-uuid-local-123');
      assert.ok(registro !== undefined);
      assert.equal(registro.estado, 'PENDIENTE_REINTENTO');
      assert.equal(registro.codigoHttp, 503);
      assert.equal(registro.payload.external_order_id, 'ORD-HTL-8842');
      assert.equal(registro.payload.admin_id, 'admin-recepcionista');
      assert.equal(registro.payload.huespedes_reales, 3); // 2 adultos + 1 niño
      assert.equal(registro.payload.observaciones, TEXTO_OBSERVACIONES_POR_DEFECTO);

      // Ahora simulamos que el reintento posterior funciona cuando Booking se recupera
      const mockFetchExitoso: typeof fetch = (async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;
      mockFetchActual = mockFetchExitoso;

      const resultadosReintento = await bookingClient.reintentarPendientes(mockFetchExitoso);
      assert.equal(resultadosReintento.length, 1);
      assert.equal(resultadosReintento[0].estado, 'ENVIADO');
      assert.equal(resultadosReintento[0].codigoHttp, 200);

      // Ya no quedan reintentos pendientes
      assert.equal(bookingClient.obtenerReintentosPendientes().length, 0);
    });
  });
});

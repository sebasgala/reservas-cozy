import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { registrarV2 } from '../../comun/v2/registro-v2';

export interface NotificarCheckinBookingRequest {
  order_id?: string;
  external_order_id: string;
  client_id: string;
  estado: 'CONFIRMADO_ASISTIDO';
  huespedes_reales: number;
  admin_id: string;
  fecha_checkin: string;
  observaciones?: string | null;
}

export interface ResultadoNotificacionBooking {
  exito: boolean;
  /** true si no se intentó el envío porque la notificación está deshabilitada (sin clave); no es un fallo a reintentar */
  omitido?: boolean;
  estadoHttp?: number;
  respuesta?: unknown;
  error?: string;
}

export interface RegistroCheckinBooking {
  ordenId: string;
  external_order_id: string;
  payload: NotificarCheckinBookingRequest;
  estado: 'ENVIADO' | 'PENDIENTE_REINTENTO';
  codigoHttp?: number;
  respuesta?: unknown;
  error?: string;
  intentos: number;
  ultimoIntento: Date;
  proximoReintento?: Date;
}

export interface ParametrosCheckinBooking {
  order_id?: string;
  external_order_id: string;
  client_id: string;
  huespedes_reales: number;
  admin_id: string;
  fecha_checkin: Date | string;
  observaciones?: string | null;
}

export const TEXTO_OBSERVACIONES_POR_DEFECTO = 'Check-in confirmado localmente';

export interface ConfiguracionBooking {
  /** false si en producción falta la clave: solo se deshabilita la notificación de check-in, el servicio arranca igual */
  habilitada: boolean;
  aviso?: string;
}

/**
 * Evalúa la configuración de entorno para Booking. No impide el arranque: si en producción (NODE_ENV=production)
 * falta BOOKING_CHECKIN_KEY (o BOOKING_API_KEY), devuelve habilitada=false con el aviso para el log.
 */
export function validarConfiguracionBooking(env: NodeJS.ProcessEnv = process.env): ConfiguracionBooking {
  if (env.NODE_ENV === 'production') {
    const clave = env.BOOKING_CHECKIN_KEY || env.BOOKING_API_KEY;
    if (!clave || clave.trim() === '') {
      return {
        habilitada: false,
        aviso:
          'Falta BOOKING_CHECKIN_KEY (o BOOKING_API_KEY): la notificación de check-in a Booking queda deshabilitada. El servicio arranca igual.',
      };
    }
  }
  return { habilitada: true };
}

/**
 * Convierte un instante (Date o string de Guayaquil UTC-5) a ISO UTC con terminación 'Z'.
 */
export function formatearFechaCheckinUtc(fecha: Date | string): string {
  if (fecha instanceof Date) {
    return fecha.toISOString();
  }
  const limpia = fecha.trim();
  if (limpia.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(limpia)) {
    return new Date(limpia).toISOString();
  }
  // Sin zona horaria especificada: asumimos hora local de Guayaquil (UTC-5)
  return new Date(`${limpia}-05:00`).toISOString();
}

/**
 * Construye el cuerpo del mensaje para Booking con las transformaciones y valores por defecto del anexo.
 */
export function construirCuerpoCheckinBooking(params: ParametrosCheckinBooking): NotificarCheckinBookingRequest {
  const observaciones =
    params.observaciones && params.observaciones.trim().length > 0
      ? params.observaciones.trim()
      : TEXTO_OBSERVACIONES_POR_DEFECTO;

  return {
    ...(params.order_id ? { order_id: params.order_id } : {}),
    external_order_id: params.external_order_id,
    client_id: params.client_id,
    estado: 'CONFIRMADO_ASISTIDO',
    huespedes_reales: Math.max(1, Math.floor(params.huespedes_reales || 1)),
    admin_id: params.admin_id || 'admin-recepcion',
    fecha_checkin: formatearFechaCheckinUtc(params.fecha_checkin),
    observaciones,
  };
}

@Injectable()
export class BookingCheckinClient implements OnModuleInit {
  private readonly log = new Logger('BookingCheckinClient');
  private readonly registros = new Map<string, RegistroCheckinBooking>();

  constructor(
    @Optional() private readonly bookingUrlCustom?: string,
    @Optional() private readonly apiKeyCustom?: string,
  ) {}

  private notificacionHabilitada = true;

  onModuleInit(): void {
    const config = validarConfiguracionBooking(process.env);
    this.notificacionHabilitada = config.habilitada;
    if (!config.habilitada) this.log.warn(config.aviso);
  }

  get habilitada(): boolean {
    return this.notificacionHabilitada;
  }

  get bookingUrl(): string {
    if (this.bookingUrlCustom) return this.bookingUrlCustom;
    if (process.env.BOOKING_URL) return process.env.BOOKING_URL;
    return process.env.NODE_ENV === 'production'
      ? 'https://booking-core-api.azurewebsites.net'
      : 'http://localhost:3000';
  }

  get apiKey(): string {
    return this.apiKeyCustom || process.env.BOOKING_CHECKIN_KEY || process.env.BOOKING_API_KEY || '';
  }

  construirPayload(params: ParametrosCheckinBooking): NotificarCheckinBookingRequest {
    return construirCuerpoCheckinBooking(params);
  }

  async notificarCheckin(
    payload: NotificarCheckinBookingRequest,
    correlacionId?: string | null,
    fetchFn: typeof fetch = fetch,
    referenciasAlternativas: string[] = [],
  ): Promise<ResultadoNotificacionBooking> {
    if (!this.notificacionHabilitada) {
      registrarV2('warn', 'booking_checkin_omitido', {
        correlationId: correlacionId,
        external_order_id: payload.external_order_id,
        motivo: 'sin_clave_booking',
      });
      return { exito: false, omitido: true, error: 'Notificación a Booking deshabilitada: falta BOOKING_CHECKIN_KEY.' };
    }

    const base = this.bookingUrl.replace(/\/+$/, '');
    const candidatos = Array.from(
      new Set([payload.external_order_id, ...referenciasAlternativas].filter((v) => v && v.trim().length > 0)),
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      ...(correlacionId ? { 'X-Correlation-ID': correlacionId } : {}),
    };

    let ultimoResultado: ResultadoNotificacionBooking = { exito: false, error: 'Sin referencias para notificar' };

    for (const ref of candidatos) {
      const url = `${base}/api/v1/reservas/${encodeURIComponent(ref)}/checkin`;
      const cuerpoEnvio: NotificarCheckinBookingRequest = {
        ...payload,
        order_id: ref,
        external_order_id: ref,
      };

      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(cuerpoEnvio),
        });

        const texto = await res.text();
        let cuerpo: unknown = null;
        try {
          cuerpo = texto ? JSON.parse(texto) : null;
        } catch {
          cuerpo = texto;
        }

        if (res.ok) {
          return {
            exito: true,
            estadoHttp: res.status,
            respuesta: cuerpo,
          };
        }

        ultimoResultado = {
          exito: false,
          estadoHttp: res.status,
          error: `Error de Booking (${res.status}): ${typeof cuerpo === 'object' && cuerpo && 'detail' in (cuerpo as any) ? (cuerpo as any).detail : texto || res.statusText}`,
          respuesta: cuerpo,
        };

        // Solo probamos otra referencia si Booking respondió 404 (no encontró ese ID)
        if (res.status !== 404) {
          return ultimoResultado;
        }
      } catch (err) {
        return {
          exito: false,
          error: `Fallo de comunicación con Booking: ${(err as Error).message}`,
        };
      }
    }

    return ultimoResultado;
  }

  async guardarResultado(
    ordenId: string,
    payload: NotificarCheckinBookingRequest | null,
    resultado: ResultadoNotificacionBooking,
    correlacionId?: string | null,
  ): Promise<RegistroCheckinBooking> {
    const ahora = new Date();
    const existente = this.registros.get(ordenId);
    const intentos = (existente?.intentos ?? 0) + 1;

    const carga = payload ?? existente?.payload;
    if (!carga) {
      throw new Error(`No hay payload disponible para registrar resultado de la orden ${ordenId}`);
    }

    const registro: RegistroCheckinBooking = {
      ordenId,
      external_order_id: carga.external_order_id,
      payload: carga,
      estado: resultado.exito ? 'ENVIADO' : 'PENDIENTE_REINTENTO',
      codigoHttp: resultado.estadoHttp,
      respuesta: resultado.respuesta,
      error: resultado.error,
      intentos,
      ultimoIntento: ahora,
      ...(resultado.exito
        ? {}
        : { proximoReintento: new Date(ahora.getTime() + Math.min(60_000, 1_000 * 2 ** (intentos - 1))) }),
    };

    this.registros.set(ordenId, registro);

    if (resultado.exito) {
      registrarV2('info', 'booking_checkin_notificado', {
        correlationId: correlacionId,
        orderId: ordenId,
        external_order_id: registro.external_order_id,
        estadoHttp: resultado.estadoHttp,
      });
    } else {
      registrarV2('warn', 'booking_checkin_fallido', {
        correlationId: correlacionId,
        orderId: ordenId,
        external_order_id: registro.external_order_id,
        estadoHttp: resultado.estadoHttp,
        error: resultado.error,
        reintento_pendiente: true,
        intentos,
      });
    }

    return registro;
  }

  obtenerRegistro(ordenId: string): RegistroCheckinBooking | undefined {
    return this.registros.get(ordenId);
  }

  obtenerReintentosPendientes(): RegistroCheckinBooking[] {
    return Array.from(this.registros.values()).filter((r) => r.estado === 'PENDIENTE_REINTENTO');
  }

  async reintentarPendientes(fetchFn: typeof fetch = fetch): Promise<RegistroCheckinBooking[]> {
    const pendientes = this.obtenerReintentosPendientes();
    const resultados: RegistroCheckinBooking[] = [];

    for (const p of pendientes) {
      const res = await this.notificarCheckin(p.payload, undefined, fetchFn);
      const actualizado = await this.guardarResultado(p.ordenId, p.payload, res);
      resultados.push(actualizado);
    }

    return resultados;
  }
}


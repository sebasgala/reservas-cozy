import { Body, Controller, Get, HttpCode, Param, PipeTransform, Post, Put, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { esUuid } from '../../comun/alojamientos-consulta.utils';
import { AutenticacionV2Guard, PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { auditarAccesoPii } from '../../comun/v2/registro-v2';
import { OperacionV2 } from '../../usuarios/v2/seguridad-v2';
import { idAlojamientoV2 } from '../../comun/v2/id-alojamiento-v2';
import { PaginaV2Query } from '../../catalogo/v2/dto/catalogo-v2.dto';
import { CancelarOrdenV2Dto, CrearOrdenV2Dto, ListarOrdenesV2Query } from './dto/ordenes-v2.dto';
import { CheckInV2Dto, CheckOutV2Dto, EarlyCheckinV2Dto } from './dto/estancia-v2.dto';
import { EstanciaV2Service } from './estancia-v2.service';
import { ahoraDe, numeroDePrueba } from '../../comun/v2/reloj-prueba';
import { RespuestaIdempotente } from './idempotencia-v2';
import { OrdenesV2Service } from './ordenes-v2.service';
import { peticionInvalida, ProblemaV2Filter, reglaDeNegocio } from '../../comun/v2/problemas-v2';
import { Reloj } from '../../comun/v2/reloj';
import { validacionConsultaV2, validacionCuerpoV2 } from '../../comun/v2/validacion-v2';

// Órdenes del contrato v2 y sus alias deprecados. Este controlador se registra ANTES que AlojamientoV2Controller:
// /alojamientos/orders, /reservations y /reservas son rutas estáticas con precedencia sobre /alojamientos/{id}.

// OrderRef del contrato: UUID, ORD-HTL-… o BK-HOTEL-…
const REF_ORDEN = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|ORD-HTL-[A-Z0-9]{3,20}|BK-HOTEL-[A-Z0-9]{3,20})$/;
const refOrden = (nombre: string): PipeTransform<string, string> => ({
  transform(valor: string) {
    if (!REF_ORDEN.test(valor)) throw peticionInvalida([{ name: nombre, reason: 'debe ser un UUID, un ORD-HTL-… o un BK-HOTEL-…' }]);
    return valor;
  },
});

// Idempotency-Key: obligatoria y UUID (§1.2)
function claveIdempotencia(req: Request): string {
  const clave = req.header('idempotency-key')?.trim();
  if (!clave) throw peticionInvalida([{ name: 'Idempotency-Key', reason: 'la cabecera Idempotency-Key es obligatoria' }]);
  if (!esUuid(clave)) throw peticionInvalida([{ name: 'Idempotency-Key', reason: 'debe ser un UUID' }]);
  return clave.toLowerCase();
}

function responder(res: Response, r: RespuestaIdempotente) {
  res.status(r.status);
  for (const [nombre, valor] of Object.entries(r.cabeceras ?? {})) res.setHeader(nombre, valor);
  if (r.repetida) res.setHeader('Idempotent-Replayed', 'true');
  return r.cuerpo;
}

@ApiTags('Contrato v2 - Reservas y Órdenes Saga')
@Controller({ path: 'alojamientos', version: '2' })
@UseFilters(ProblemaV2Filter)
@UseGuards(AutenticacionV2Guard)
export class OrdenesV2Controller {
  constructor(
    private readonly ordenes: OrdenesV2Service,
    private readonly estancia: EstanciaV2Service,
    private readonly reloj: Reloj,
  ) {}

  private principal(req: Request): PrincipalV2 {
    return (req as Request & { principalV2: PrincipalV2 }).principalV2;
  }

  private correlacion(req: Request): string | null {
    return (req as Request & { correlationId?: string }).correlationId ?? null;
  }

  private ahora(req: Request): Date {
    return ahoraDe(this.reloj, req);
  }

  // La respuesta de un check-in lleva la clave digital (x-secret): no se cachea (contrato)
  private sinCache(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
  }

  private async checkIn(req: Request, res: Response, ref: string, cuerpo: CheckInV2Dto) {
    this.sinCache(res);
    return this.estancia.checkIn(ref, cuerpo, this.principal(req), this.ahora(req), this.correlacion(req));
  }

  private async checkOut(req: Request, ref: string, cuerpo: CheckOutV2Dto) {
    return this.estancia.checkOut(ref, cuerpo ?? {}, this.principal(req), this.ahora(req), this.correlacion(req));
  }

  private async crear(req: Request, res: Response, cuerpo: CrearOrdenV2Dto) {
    const principal = this.principal(req);
    const clave = claveIdempotencia(req);
    return responder(res, await this.ordenes.crear(cuerpo, clave, principal, this.ahora(req), numeroDePrueba(req, 'x-prueba-retraso-ms'), this.correlacion(req)));
  }

  private async cancelar(req: Request, res: Response, ref: string, cuerpo: CancelarOrdenV2Dto) {
    const principal = this.principal(req);
    const clave = claveIdempotencia(req);
    return responder(res, await this.ordenes.cancelar(ref, cuerpo ?? {}, clave, principal, this.ahora(req), this.correlacion(req)));
  }

  private async obtener(req: Request, res: Response, ref: string) {
    this.sinCache(res); // puede traer la clave digital de la habitación
    auditarAccesoPii(req, 'getOrder', ref);
    return this.ordenes.obtener(ref, this.principal(req));
  }

  @Post('orders/create')
  @ApiOperation({ operationId: 'createOrder', summary: 'Crear reserva (contrato síncrono de la Saga, ≤ 3000 ms)' })
  @OperacionV2('createOrder')
  crearOrden(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body(validacionCuerpoV2()) cuerpo: CrearOrdenV2Dto) {
    return this.crear(req, res, cuerpo);
  }

  @Post('reservas')
  @ApiOperation({ operationId: 'createOrder_alojamientos_reservas', summary: 'Alias deprecado de orders/create', deprecated: true })
  @OperacionV2('createOrder_alojamientos_reservas')
  crearReserva(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body(validacionCuerpoV2()) cuerpo: CrearOrdenV2Dto) {
    return this.crear(req, res, cuerpo);
  }

  @Get('orders')
  @ApiOperation({ operationId: 'listOrders', summary: 'Buscar órdenes (recuperación de la Saga y conciliación)' })
  @OperacionV2('listOrders')
  async listar(@Req() req: Request, @Query(validacionConsultaV2()) consulta: ListarOrdenesV2Query) {
    const principal = this.principal(req);
    auditarAccesoPii(req, 'listOrders');
    return this.ordenes.listar(consulta, principal);
  }

  @Get('orders/:orderId')
  @ApiOperation({ operationId: 'getOrder', summary: 'Detalle y estado de una reserva' })
  @OperacionV2('getOrder')
  obtenerOrden(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('orderId', refOrden('orderId')) ref: string) {
    return this.obtener(req, res, ref);
  }

  @Post('orders/:orderId/check-in')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkInOrder', summary: 'Check-in digital (desde las 14:00 hora de Guayaquil)' })
  @OperacionV2('checkInOrder')
  checkInOrden(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('orderId', refOrden('orderId')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CheckInV2Dto) {
    return this.checkIn(req, res, ref, cuerpo);
  }

  @Put('orders/:orderId/early-checkin')
  @ApiOperation({ operationId: 'setEarlyCheckin', summary: 'Autorizar early check-in (solo ADMIN / recepción)' })
  @OperacionV2('setEarlyCheckin')
  earlyCheckin(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('orderId', refOrden('orderId')) ref: string, @Body(validacionCuerpoV2()) cuerpo: EarlyCheckinV2Dto) {
    this.sinCache(res);
    return this.estancia.earlyCheckin(ref, cuerpo, this.principal(req), this.ahora(req), this.correlacion(req));
  }

  @Post('orders/:orderId/checkout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkOutOrder', summary: 'Check-out, liquidación de consumos y liberación de habitación' })
  @OperacionV2('checkOutOrder')
  checkOutOrden(@Req() req: Request, @Param('orderId', refOrden('orderId')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CheckOutV2Dto) {
    return this.checkOut(req, ref, cuerpo);
  }

  @Post('orders/:orderId/cancel')
  @ApiOperation({ operationId: 'cancelOrder', summary: 'Cancelar reserva (acción compensatoria de la Saga)' })
  @OperacionV2('cancelOrder')
  cancelarOrden(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('orderId', refOrden('orderId')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CancelarOrdenV2Dto) {
    return this.cancelar(req, res, ref, cuerpo);
  }

  @Get('reservations')
  @ApiOperation({ operationId: 'listMyReservations', summary: 'Mis reservas (usuario del token)' })
  @OperacionV2('listMyReservations')
  async misReservas(@Req() req: Request, @Query(validacionConsultaV2()) pagina: PaginaV2Query) {
    const principal = this.principal(req);
    return this.ordenes.misReservas(pagina, principal);
  }

  @Get('reservas/:id')
  @ApiOperation({ operationId: 'getOrder_alojamientos_reservas_id', summary: 'Alias deprecado de orders/{orderId}', deprecated: true })
  @OperacionV2('getOrder_alojamientos_reservas_id')
  obtenerReserva(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id', refOrden('id')) ref: string) {
    return this.obtener(req, res, ref);
  }

  @Post('reservas/:id/checkin')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkInOrder_alojamientos_reservas_id_checkin', summary: 'Alias deprecado de orders/{orderId}/check-in', deprecated: true })
  @OperacionV2('checkInOrder_alojamientos_reservas_id_checkin')
  checkInReserva(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id', refOrden('id')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CheckInV2Dto) {
    return this.checkIn(req, res, ref, cuerpo);
  }

  @Post('reservations/:reservationId/checkin')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkInOrder_alojamientos_reservations_reservationId_checkin', summary: 'Alias deprecado de orders/{orderId}/check-in', deprecated: true })
  @OperacionV2('checkInOrder_alojamientos_reservations_reservationId_checkin')
  checkInReservation(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('reservationId', refOrden('reservationId')) ref: string,
    @Body(validacionCuerpoV2()) cuerpo: CheckInV2Dto,
  ) {
    return this.checkIn(req, res, ref, cuerpo);
  }

  @Post('reservas/:id/checkout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkOutOrder_alojamientos_reservas_id_checkout', summary: 'Alias deprecado de orders/{orderId}/checkout', deprecated: true })
  @OperacionV2('checkOutOrder_alojamientos_reservas_id_checkout')
  checkOutReserva(@Req() req: Request, @Param('id', refOrden('id')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CheckOutV2Dto) {
    return this.checkOut(req, ref, cuerpo);
  }

  @Post('reservations/:reservationId/checkout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'checkOutOrder_alojamientos_reservations_reservationId_checkout', summary: 'Alias deprecado de orders/{orderId}/checkout', deprecated: true })
  @OperacionV2('checkOutOrder_alojamientos_reservations_reservationId_checkout')
  checkOutReservation(@Req() req: Request, @Param('reservationId', refOrden('reservationId')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CheckOutV2Dto) {
    return this.checkOut(req, ref, cuerpo);
  }

  @Get('reservations/:reservationId')
  @ApiOperation({ operationId: 'getOrder_alojamientos_reservations_reservationId', summary: 'Alias deprecado de orders/{orderId}', deprecated: true })
  @OperacionV2('getOrder_alojamientos_reservations_reservationId')
  obtenerReservation(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('reservationId', refOrden('reservationId')) ref: string) {
    return this.obtener(req, res, ref);
  }

  @Post('reservas/:id/cancel')
  @ApiOperation({ operationId: 'cancelOrder_alojamientos_reservas_id_cancel', summary: 'Alias deprecado de orders/{orderId}/cancel', deprecated: true })
  @OperacionV2('cancelOrder_alojamientos_reservas_id_cancel')
  cancelarReserva(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id', refOrden('id')) ref: string, @Body(validacionCuerpoV2()) cuerpo: CancelarOrdenV2Dto) {
    return this.cancelar(req, res, ref, cuerpo);
  }

  @Post('reservations/:reservationId/cancel')
  @ApiOperation({ operationId: 'cancelOrder_alojamientos_reservations_reservationId_cancel', summary: 'Alias deprecado de orders/{orderId}/cancel', deprecated: true })
  @OperacionV2('cancelOrder_alojamientos_reservations_reservationId_cancel')
  cancelarReservation(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('reservationId', refOrden('reservationId')) ref: string,
    @Body(validacionCuerpoV2()) cuerpo: CancelarOrdenV2Dto,
  ) {
    return this.cancelar(req, res, ref, cuerpo);
  }

  // Alias con el alojamiento en la ruta: debe ser el mismo que el del cuerpo
  @Post(':id/reservations')
  @ApiOperation({ operationId: 'createOrder_alojamientos_id_reservations', summary: 'Alias deprecado de orders/create', deprecated: true })
  @OperacionV2('createOrder_alojamientos_id_reservations')
  crearEnAlojamiento(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id', idAlojamientoV2) id: string, @Body(validacionCuerpoV2()) cuerpo: CrearOrdenV2Dto) {
    if (cuerpo.alojamientoId !== id) {
      throw reglaDeNegocio('VALIDATION_FAILED', 'El alojamientoId del cuerpo no coincide con el de la ruta.', [{ name: 'alojamientoId', reason: `debe ser ${id}` }]);
    }
    return this.crear(req, res, cuerpo);
  }
}

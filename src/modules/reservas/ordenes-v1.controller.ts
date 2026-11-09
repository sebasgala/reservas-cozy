import {
  Controller, Get, Post, Delete, Body, Param, Headers, Req,
  ParseUUIDPipe, UseGuards, UseFilters, UsePipes, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags, ApiOperation, ApiResponse, ApiParam,
  ApiHeader, ApiSecurity, ApiBody, ApiExtraModels, getSchemaPath,
} from '@nestjs/swagger';
import { IdempotencyKeyGuard } from '../../common/guards/idempotency-key.guard';
import { ProblemDetailsDto } from '../comun/dto/problem-details.dto';
import { ProblemDetailsFilter } from '../comun/problems/problem-details.filter';
import { ConsultaInvalidaException } from '../comun/problems/problem-details.exceptions';
import { OrdenesService } from './ordenes.service';
import { OrderPreviewRequestDto, OrderPreviewResponseDto } from './dto/order-preview.dto';
import { OrderCreateRequestDto } from './dto/order-create.dto';
import { OrderDetailDto } from './dto/order-detail.dto';
import { validarIdempotencyKey } from '../comun/alojamientos-consulta.utils';
import { validacionContrato } from '../comun/problems/validacion.pipes';
import { AuthService } from '../usuarios/seguridad/auth.service';

// ─────────────────────────────────────────────────────────────────────────────
// Controlador de Órdenes y Webhooks v1 (fase 9.2)
// Alineado 1:1 con alojamientos-openapi.yaml. Repartido a reservas (§2 del diseño).
// ─────────────────────────────────────────────────────────────────────────────

const uuidDeOrden = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new ConsultaInvalidaException([{ name: 'orderId', reason: 'orderId debe ser un UUID válido' }]),
  });

const CABECERA_IDEMPOTENCIA = {
  name: 'Idempotency-Key',
  required: true,
  description: 'UUID. Repetir la petición con la misma clave y el mismo cuerpo devuelve la misma respuesta sin repetir la operación',
  example: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
};

const respuestaProblema = (status: number, description: string) => ({
  status,
  description,
  content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailsDto) } } },
});

@ApiExtraModels(ProblemDetailsDto)
@UsePipes(validacionContrato())
@Controller()
export class OrdenesV1Controller {
  constructor(
    private readonly ordenesService: OrdenesService,
    private readonly authService: AuthService,
  ) {}

  @Post('orders/preview')
  @HttpCode(HttpStatus.OK)
  @UseFilters(ProblemDetailsFilter)
  @ApiTags('Gestión de Órdenes (Reservas)')
  @ApiSecurity('OAuth2Security', ['alojamientos:read'])
  @ApiOperation({
    summary: 'Previsualizar orden antes de confirmar',
    description:
      'Comprueba disponibilidad y calcula el precio final (suma de las noches por habitación × habitaciones). ' +
      'Guarda la vista previa 15 minutos y NO descuenta cupos. Las fechas y la habitación salen del `product_id` ' +
      '(`<uuid-habitación>:<checkin>:<checkout>`), que debe obtenerse de /availability. ' +
      'PENDIENTE: el contrato exige OAuth2 (alojamientos:read); todavía no hay autenticación.',
  })
  @ApiBody({
    type: OrderPreviewRequestDto,
    examples: {
      'Suite Junior, fin de semana': {
        value: {
          accommodation_id: 1,
          product_id: '704fe49f-9024-4f7e-b023-df55a3aab5c1:2026-10-09:2026-10-12',
          guests: { number_of_adults: 2, number_of_rooms: 1, children: [5] },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Detalles de la orden previsualizada y precios finales', type: OrderPreviewResponseDto })
  @ApiResponse(respuestaProblema(400, 'Petición inválida (incluye huéspedes que no caben en la habitación)'))
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: el alojamiento o la habitación no existen'))
  @ApiResponse(respuestaProblema(409, 'ROOM_NO_LONGER_AVAILABLE: sin cupos suficientes (no está definido en el contrato)'))
  previewOrder(@Body() previewRequest: OrderPreviewRequestDto) {
    return this.ordenesService.preview(previewRequest);
  }

  @Post('orders/create')
  @HttpCode(HttpStatus.CREATED)
  @UseFilters(ProblemDetailsFilter)
  @ApiTags('Gestión de Órdenes (Reservas)')
  @ApiSecurity('OAuth2Security', ['alojamientos:book'])
  @ApiOperation({
    summary: 'Crear reserva de alojamiento',
    description:
      'En una transacción: bloquea las noches, verifica cupos y precio, descuenta cupos, crea la orden (CONFIRMED, pago simulado) ' +
      'y guarda la Idempotency-Key. Misma clave y mismo cuerpo: devuelve la respuesta guardada sin crear otra orden. ' +
      'Misma clave con otro cuerpo: 422. PENDIENTE: el contrato exige OAuth2 (alojamientos:book).',
  })
  @ApiHeader(CABECERA_IDEMPOTENCIA)
  @ApiBody({
    type: OrderCreateRequestDto,
    examples: {
      'Crear con una vista previa vigente': {
        value: {
          order_preview_id: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          payment_reference: 'PAY-SIM-0001',
          customer_details: { first_name: 'Ana', last_name: 'Pérez', email: 'ana.perez@example.com' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Orden creada exitosamente', type: OrderDetailDto })
  @ApiResponse(respuestaProblema(400, 'VALIDATION_FAILED: campo obligatorio ausente o con tipo incorrecto (customer_details exige first_name y last_name no vacíos y email con formato válido), Idempotency-Key ausente o mal formada, vista previa inexistente o expirada'))
  @ApiResponse(respuestaProblema(409, 'ROOM_NO_LONGER_AVAILABLE (otra reserva tomó los cupos) o PRICE_CHANGED'))
  @ApiResponse(respuestaProblema(422, 'La Idempotency-Key ya se usó con un cuerpo distinto (no está definido en el contrato)'))
  async createOrder(
    @Headers('Idempotency-Key') idempotencyKey: string,
    @Req() peticion: Request,
    @Body() createRequest: OrderCreateRequestDto,
  ) {
    const clave = validarIdempotencyKey(idempotencyKey);
    const cliente = await this.authService.usuarioOpcional(peticion.headers.authorization);
    const respuesta = await this.ordenesService.crear(clave, createRequest, cliente?.id ?? null);
    return respuesta.body;
  }

  @Get('orders/:orderId')
  @UseFilters(ProblemDetailsFilter)
  @ApiTags('Gestión de Órdenes (Reservas)')
  @ApiSecurity('OAuth2Security', ['alojamientos:read'])
  @ApiOperation({
    summary: 'Obtener detalles de la orden',
    description: 'Devuelve la orden con su estado, fechas, habitación y enlaces HATEOAS. PENDIENTE: el contrato exige OAuth2 (alojamientos:read).',
  })
  @ApiParam({ name: 'orderId', type: 'string', format: 'uuid', example: '9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24' })
  @ApiResponse({ status: 200, description: 'Detalles completos de la orden', type: OrderDetailDto })
  @ApiResponse(respuestaProblema(400, 'orderId no es un UUID'))
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: la orden no existe'))
  getOrder(@Param('orderId', uuidDeOrden()) orderId: string) {
    return this.ordenesService.obtener(orderId);
  }

  @Post('orders/:orderId/modify')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Gestión de Órdenes (Reservas)')
  @ApiSecurity('OAuth2Security', ['alojamientos:book'])
  @ApiOperation({
    summary: 'Modificar una orden existente',
    description:
      'Ruta del contrato con datos de RELLENO: todavía no usa la base de datos y el cuerpo no se valida. Recibe OrderModifyRequest del contrato. Exige Idempotency-Key. Pide el scope OAuth2 alojamientos:book (pendiente).',
  })
  @ApiParam({ name: 'orderId', type: 'string', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4 para evitar modificaciones duplicadas' })
  @ApiResponse({ status: 200, description: 'Orden modificada' })
  @ApiResponse({ status: 409, description: 'Conflicto' })
  @UseGuards(IdempotencyKeyGuard)
  modifyOrder(
    @Headers('Idempotency-Key') _idempotencyKey: string,
    @Param('orderId', ParseUUIDPipe) _orderId: string,
    @Body() _modifyRequest: any,
  ) {
    return {};
  }

  @Post('orders/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseFilters(ProblemDetailsFilter)
  @ApiTags('Gestión de Órdenes (Reservas)')
  @ApiSecurity('OAuth2Security', ['alojamientos:cancel'])
  @ApiOperation({
    summary: 'Cancelar una orden',
    description:
      'En una transacción: pasa la orden a CANCELLED y devuelve los cupos de cada noche. Si ya estaba cancelada, ' +
      'devuelve la orden tal cual (200) sin devolver cupos otra vez. La Idempotency-Key es obligatoria pero no se guarda: ' +
      'la cancelación ya es idempotente por el estado. PENDIENTE: el contrato exige OAuth2 (alojamientos:cancel).',
  })
  @ApiParam({ name: 'orderId', type: 'string', format: 'uuid', example: '9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24' })
  @ApiHeader(CABECERA_IDEMPOTENCIA)
  @ApiResponse({ status: 200, description: 'Cancelación procesada: devuelve la orden', type: OrderDetailDto })
  @ApiResponse(respuestaProblema(400, 'orderId no es un UUID o falta la Idempotency-Key'))
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: la orden no existe'))
  @ApiResponse(respuestaProblema(409, 'Conflicto (definido en el contrato; hoy no se produce)'))
  cancelOrder(
    @Headers('Idempotency-Key') idempotencyKey: string,
    @Param('orderId', uuidDeOrden()) orderId: string,
  ) {
    validarIdempotencyKey(idempotencyKey);
    return this.ordenesService.cancelar(orderId);
  }

  @Get('webhooks')
  @ApiTags('Webhooks')
  @ApiSecurity('OAuth2Security', ['alojamientos:webhooks'])
  @ApiOperation({
    summary: 'Listar suscripciones',
    description:
      'Ruta del contrato con datos de RELLENO: todavía no usa la base de datos y el cuerpo no se valida. Pide el scope OAuth2 alojamientos:webhooks (pendiente).',
  })
  @ApiResponse({ status: 200, description: 'Suscripciones activas' })
  listWebhooks() {
    return [];
  }

  @Post('webhooks')
  @ApiTags('Webhooks')
  @ApiSecurity('OAuth2Security', ['alojamientos:webhooks'])
  @ApiOperation({
    summary: 'Registrar webhook',
    description:
      'Ruta del contrato con datos de RELLENO: todavía no usa la base de datos y el cuerpo no se valida. Recibe WebhookSubscription del contrato. Pide el scope OAuth2 alojamientos:webhooks (pendiente).',
  })
  @ApiResponse({ status: 201, description: 'Webhook registrado' })
  @HttpCode(HttpStatus.CREATED)
  createWebhook(@Body() _webhookSubscription: any) {
    return {};
  }

  @Delete('webhooks/:id')
  @ApiTags('Webhooks')
  @ApiSecurity('OAuth2Security', ['alojamientos:webhooks'])
  @ApiOperation({
    summary: 'Eliminar suscripción',
    description:
      'Ruta del contrato con datos de RELLENO: todavía no usa la base de datos y el cuerpo no se valida. Pide el scope OAuth2 alojamientos:webhooks (pendiente).',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Eliminado' })
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteWebhook(@Param('id', ParseUUIDPipe) _id: string) {}
}


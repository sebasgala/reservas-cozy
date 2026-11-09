import { ApiProperty } from '@nestjs/swagger';
import { OrdenStatus } from '../entities/orden.entity';

// Contenido de `accommodation_details`: el contrato lo deja como objeto libre; este es el formato que usamos.
export class OrderAccommodationDetailsDto {
  @ApiProperty({ type: 'integer', example: 1 })
  accommodation_id: number;

  @ApiProperty({ example: 'Cozy Boutique Quito' })
  name: string;

  @ApiProperty({ example: '704fe49f-9024-4f7e-b023-df55a3aab5c1' })
  product_id: string;

  @ApiProperty({ example: 'Suite Junior' })
  room_name: string;

  @ApiProperty({ example: 'free_cancellation', nullable: true })
  cancellation_type: string | null;

  @ApiProperty({ format: 'date', example: '2026-10-09' })
  checkin: string;

  @ApiProperty({ format: 'date', example: '2026-10-12' })
  checkout: string;

  @ApiProperty({ type: 'integer', example: 3 })
  nights: number;

  @ApiProperty({ type: 'integer', example: 1, description: 'Habitaciones reservadas (cupos descontados por noche)' })
  rooms: number;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { number_of_adults: 2, number_of_rooms: 1, children: [5] } })
  guests: Record<string, any>;
}

// Esquema `OrderDetail` del contrato.
export class OrderDetailDto {
  @ApiProperty({ format: 'uuid', example: '9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24' })
  order_id: string;

  @ApiProperty({ description: 'Código de confirmación (equivale al PNR): 8 caracteres', example: 'K7M2Q9XR' })
  locator: string;

  @ApiProperty({ enum: OrdenStatus, example: OrdenStatus.CONFIRMED })
  status: OrdenStatus;

  @ApiProperty({ type: () => OrderAccommodationDetailsDto })
  accommodation_details: OrderAccommodationDetailsDto;

  @ApiProperty({ example: 313.5 })
  total_price: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-06T04:30:00.000Z' })
  creation_date: string;

  @ApiProperty({
    description: 'HATEOAS: acciones disponibles según el estado (self siempre; modify y cancel solo si no está cancelada)',
    type: 'object',
    additionalProperties: { type: 'string', format: 'uri' },
    example: {
      self: '/api/v1/orders/9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24',
      modify: '/api/v1/orders/9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24/modify',
      cancel: '/api/v1/orders/9a1f3c52-7d2e-4b8a-9f61-3c5d7e9b1a24/cancel',
    },
  })
  _links: Record<string, string>;
}

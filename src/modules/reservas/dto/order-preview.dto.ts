import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsNotEmpty, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { AccommodationsGuestsDto } from '../../catalogo/dto/accommodations-guests.dto';

// Esquema `OrderPreviewRequest` del contrato: accommodation_id, product_id y guests.
// Las fechas y la habitación viajan dentro del product_id.
export class OrderPreviewRequestDto {
  @ApiProperty({ type: 'integer', description: 'Id (entero) del alojamiento', example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  accommodation_id: number;

  @ApiProperty({
    description:
      'Identifica una oferta concreta (habitación + fechas) con el formato `<uuid-de-la-habitación>:<checkin>:<checkout>`, ' +
      'fechas YYYY-MM-DD (unos 58 caracteres, sin espacios, máximo 200). Debe obtenerse tal cual del `product_id` que devuelve /availability.',
    example: '704fe49f-9024-4f7e-b023-df55a3aab5c1:2026-10-09:2026-10-12',
    maxLength: 200,
    pattern: '^\\S+$',
  })
  @IsString()
  @IsNotEmpty()
  // Restricciones confirmadas por los autores del contrato: sin espacios y como máximo ~200 caracteres.
  @MaxLength(200, { message: 'product_id no puede superar 200 caracteres' })
  @Matches(/^\S+$/, { message: 'product_id no puede tener espacios' })
  product_id: string;

  @ApiProperty({ type: () => AccommodationsGuestsDto })
  @IsDefined({ message: 'guests es obligatorio' })
  @ValidateNested()
  @Type(() => AccommodationsGuestsDto)
  guests: AccommodationsGuestsDto;
}

export class OrderPreviewDataDto {
  @ApiProperty({ description: 'Id de la vista previa (UUID). Vale 15 minutos', example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
  order_preview_id: string;

  @ApiProperty({ description: 'Precio final: suma de las noches por habitación × habitaciones pedidas', example: 313.5 })
  total_price: number;

  @ApiProperty({ description: 'Moneda del alojamiento', example: 'USD' })
  currency: string;
}

// Esquema `OrderPreviewResponse` del contrato.
export class OrderPreviewResponseDto {
  @ApiProperty({ example: '3f6c1f0e-8f0a-4c35-9b5d-2f6f1b6a9c11' })
  request_id: string;

  @ApiProperty({ type: () => OrderPreviewDataDto })
  data: OrderPreviewDataDto;
}

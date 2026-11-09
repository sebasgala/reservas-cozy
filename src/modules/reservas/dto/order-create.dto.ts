import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsEmail, IsNotEmpty, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

// `customer_details` del contrato. Reglas confirmadas por los autores del contrato: first_name y last_name
// obligatorios y no vacíos, email obligatorio con formato válido. Cualquier otro campo (p. ej. teléfono) es
// opcional y, como no lo usamos, se ignora.
export class CustomerDetailsDto {
  @ApiProperty({ description: 'Nombre (obligatorio, no vacío)', example: 'Ana', maxLength: 120 })
  @MaxLength(120, { message: 'no puede superar 120 caracteres' })
  @Matches(/\S/, { message: 'no puede estar vacío' })
  @IsString({ message: 'debe ser texto' })
  @IsNotEmpty({ message: 'es obligatorio y no puede estar vacío' })
  first_name: string;

  @ApiProperty({ description: 'Apellido (obligatorio, no vacío)', example: 'Pérez', maxLength: 120 })
  @MaxLength(120, { message: 'no puede superar 120 caracteres' })
  @Matches(/\S/, { message: 'no puede estar vacío' })
  @IsString({ message: 'debe ser texto' })
  @IsNotEmpty({ message: 'es obligatorio y no puede estar vacío' })
  last_name: string;

  @ApiProperty({ description: 'Correo del cliente (obligatorio, formato válido)', format: 'email', example: 'ana.perez@example.com', maxLength: 255 })
  @MaxLength(255, { message: 'no puede superar 255 caracteres' })
  @IsEmail({}, { message: 'formato inválido' })
  @IsNotEmpty({ message: 'es obligatorio' })
  email: string;
}

// Esquema `OrderCreateRequest` del contrato.
export class OrderCreateRequestDto {
  @ApiProperty({ description: 'Id devuelto por /orders/preview (vence a los 15 minutos)', example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
  @IsString()
  @IsNotEmpty()
  order_preview_id: string;

  @ApiProperty({ description: 'Referencia del pago (simulado: se guarda, no se cobra)', example: 'PAY-SIM-0001', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  payment_reference: string;

  @ApiProperty({ type: () => CustomerDetailsDto })
  @IsDefined({ message: 'customer_details es obligatorio' })
  @ValidateNested()
  @Type(() => CustomerDetailsDto)
  customer_details: CustomerDetailsDto;
}

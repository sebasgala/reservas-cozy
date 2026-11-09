import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { OrdenStatus } from '../../entities/orden.entity';
import { OrderDetailDto } from '../order-detail.dto';
import { PaginaMetaDto } from '../../../usuarios/dto/admin/usuario-admin.dto';

// Paginación + filtro por estado, para las listas de reservas (de la cuenta y del admin).
export class FiltroReservasQueryDto {
  @ApiPropertyOptional({ enum: OrdenStatus })
  @IsOptional()
  @IsEnum(OrdenStatus, { message: 'debe ser PENDING, CONFIRMED o CANCELLED' })
  estado?: OrdenStatus;

  @ApiPropertyOptional({ type: 'integer', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page?: number = 1;

  @ApiPropertyOptional({ type: 'integer', default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

// Solo el admin: además puede filtrar por alojamiento.
export class FiltroReservasAdminQueryDto extends FiltroReservasQueryDto {
  @ApiPropertyOptional({ type: 'integer', description: 'Solo las reservas de este alojamiento', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  alojamientoId?: number;
}

export class ConsultarReservaDto {
  @ApiProperty({ description: 'Localizador de 8 caracteres que recibió el cliente al reservar', example: 'K7M2Q9XR' })
  @Matches(/^[A-Za-z0-9]{4,50}$/, { message: 'formato inválido' })
  @MaxLength(50, { message: 'no puede superar 50 caracteres' })
  @IsString({ message: 'debe ser texto' })
  @IsNotEmpty({ message: 'es obligatorio' })
  localizador: string;

  @ApiProperty({ description: 'Correo con el que se hizo la reserva', example: 'ana.perez@example.com' })
  @MaxLength(255, { message: 'no puede superar 255 caracteres' })
  @IsEmail({}, { message: 'formato inválido' })
  @IsNotEmpty({ message: 'es obligatorio' })
  correo: string;
}

export class ClienteReservaDto {
  @ApiProperty({ example: 'Ana' })
  first_name: string;

  @ApiProperty({ example: 'Pérez' })
  last_name: string;

  @ApiProperty({ example: 'ana.perez@example.com' })
  email: string;
}

// Reserva vista por el administrador: el detalle del contrato más quién reservó.
export class ReservaAdminDto extends OrderDetailDto {
  @ApiProperty({ type: () => ClienteReservaDto })
  customer_details: ClienteReservaDto;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'Cuenta del cliente; null = compra sin cuenta' })
  cliente_id: string | null;
}

export class ReservasPaginadasDto {
  @ApiProperty({ type: () => [OrderDetailDto] })
  data: OrderDetailDto[];

  @ApiProperty({ type: () => PaginaMetaDto })
  meta: PaginaMetaDto;
}

export class ReservasAdminPaginadasDto {
  @ApiProperty({ type: () => [ReservaAdminDto] })
  data: ReservaAdminDto[];

  @ApiProperty({ type: () => PaginaMetaDto })
  meta: PaginaMetaDto;
}

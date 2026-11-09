import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TIPOS_VIAJE } from '../../entities/resena.entity';

const MONEY = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const TELEFONO = /^(\+[0-9]{8,15}|09[0-9]{8})$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const OrderRef = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|ORD-HTL-[A-Z0-9]{3,20}|BK-HOTEL-[A-Z0-9]{3,20})$/;

// POST /alojamientos/orders/{orderId}/check-in (CheckInRequestV2)
export class CheckInV2Dto {
  @Matches(/^[A-Za-z0-9]{6,13}$/, { message: 'titularIdentificacion debe tener 6 a 13 caracteres alfanuméricos' })
  titularIdentificacion: string;

  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: 'horaLlegadaEstimada debe tener el formato HH:MM' })
  horaLlegadaEstimada?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  peticionesEspeciales?: string;
}

// PUT /alojamientos/orders/{orderId}/early-checkin (EarlyCheckinRequestV2)
export class EarlyCheckinV2Dto {
  @IsBoolean()
  autorizado: boolean;

  @IsOptional()
  @IsDateString({ strict: true })
  habilitadoDesde?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  motivo?: string;
}

class ConsumoMinibarV2Dto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  item: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  cantidad?: number;

  @Matches(MONEY, { message: 'precio debe ser un importe Money, por ejemplo "3.50"' })
  precio: string;
}

// POST /alojamientos/orders/{orderId}/checkout (CheckOutRequestV2). El cuerpo es opcional.
export class CheckOutV2Dto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ConsumoMinibarV2Dto)
  consumosMinibar?: ConsumoMinibarV2Dto[];

  @IsOptional()
  @IsIn(['TARJETA_REGISTRADA', 'EFECTIVO', 'CARGO_A_RESERVA'])
  metodoPagoConsumos?: 'TARJETA_REGISTRADA' | 'EFECTIVO' | 'CARGO_A_RESERVA';
}

class DesgloseCalificacionesV2Dto {
  @IsOptional() @IsNumber() @Min(0) @Max(10) limpieza?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) confort?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) ubicacion?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) personal?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) relacionCalidadPrecio?: number;
}

// POST /alojamientos/{id}/resenas (CrearResenaRequestV2)
export class CrearResenaV2Dto {
  @Matches(OrderRef, { message: 'reservaId debe ser un UUID, un ORD-HTL-… o un BK-HOTEL-…' })
  reservaId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(10)
  calificacionGlobal: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesgloseCalificacionesV2Dto)
  desgloseCalificaciones?: DesgloseCalificacionesV2Dto;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  comentario: string;

  @IsOptional()
  @IsIn(TIPOS_VIAJE)
  tipoViaje?: (typeof TIPOS_VIAJE)[number];
}

class ContactoComercialV2Dto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nombre?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @Matches(TELEFONO, { message: 'telefono debe estar en formato E.164 (+593…) o local (09…)' })
  telefono?: string;
}

// PUT /alojamientos/promociones/contrato (ContratoPromocionesRequestV2)
export class ContratoPromocionesV2Dto {
  @IsBoolean()
  permite_promociones: boolean;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(50)
  porcentaje_descuento_maximo: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(80, { each: true })
  destinos_habilitados?: string[];

  @IsOptional()
  @Matches(FECHA, { message: 'vigencia_hasta debe tener el formato YYYY-MM-DD' })
  vigencia_hasta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  condiciones_combo?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactoComercialV2Dto)
  contacto_comercial?: ContactoComercialV2Dto;
}

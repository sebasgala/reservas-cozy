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
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ID_ALOJAMIENTO, OcupantesV2Dto } from '../../../disponibilidad/disponibilidad.puerto';
import { PaginaV2Query } from '../../../catalogo/v2/dto/catalogo-v2.dto';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const DOS_PALABRAS = /^\S+(\s+\S+)+$/;
const TELEFONO = /^(\+[0-9]{8,15}|09[0-9]{8})$/;
const REGIMENES = ['SOLO_HABITACION', 'DESAYUNO_INCLUIDO', 'MEDIA_PENSION', 'PENSION_COMPLETA', 'TODO_INCLUIDO'] as const;
const METODOS_PAGO = ['TARJETA_CREDITO', 'TARJETA_DEBITO', 'TRANSFERENCIA', 'SIMULADO', 'PAGO_EN_SITIO'] as const;
const ESTADOS = ['PENDING', 'CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

// Titular de la reserva (HuespedTitularV2). La identificación se valida por tipo en el servicio (422 INVALID_DOCUMENT).
export class HuespedTitularV2Dto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  @Matches(DOS_PALABRAS, { message: 'nombreCompleto debe tener al menos nombre y apellido' })
  nombreCompleto: string;

  @IsIn(['CEDULA', 'PASAPORTE', 'RUC'])
  tipoDocumento: 'CEDULA' | 'PASAPORTE' | 'RUC';

  @IsString()
  @MaxLength(13)
  identificacion: string;

  @IsEmail()
  @MaxLength(120)
  email: string;

  @Matches(TELEFONO, { message: 'telefono debe estar en formato E.164 (+593…) o local (09…)' })
  telefono: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  nacionalidad?: string;
}

// Contacto en snake_case (deprecado en el contrato, se acepta si no viene huespedTitular)
export class CustomerContactV2Dto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  @Matches(DOS_PALABRAS, { message: 'full_name debe tener al menos nombre y apellido' })
  full_name: string;

  @IsEmail()
  @MaxLength(120)
  email: string;

  @Matches(TELEFONO, { message: 'phone debe estar en formato E.164 (+593…) o local (09…)' })
  phone: string;

  @IsIn(['CEDULA', 'PASAPORTE', 'RUC'])
  document_type: 'CEDULA' | 'PASAPORTE' | 'RUC';

  @IsString()
  @MaxLength(13)
  document_id: string;
}

export class HuespedAcompananteV2Dto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  nombreCompleto: string;

  @IsOptional()
  @IsIn(['CEDULA', 'PASAPORTE', 'MENOR_SIN_DOC'])
  tipoDocumento?: string;

  @IsOptional()
  @Matches(/^([0-9]{10}|[A-Z0-9]{6,12}|[0-9]{13})?$/, { message: 'identificacion no tiene un formato de documento válido' })
  identificacion?: string;

  @IsOptional()
  @IsBoolean()
  esMenorEdad?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  edad?: number;
}

export class PaqueteAplicadoV2Dto {
  @IsUUID()
  paqueteId: string;

  @IsNumber()
  @Min(0)
  @Max(50)
  descuentoPorcentaje: number;

  @Matches(MONEY, { message: 'descuentoMonto debe ser un importe Money, por ejemplo "48.00"' })
  descuentoMonto: string;
}

// POST /alojamientos/orders/create (OrderCreateRequestV2)
export class CrearOrdenV2Dto {
  @IsString()
  @Matches(ID_ALOJAMIENTO, { message: 'alojamientoId no tiene el formato de un id de propiedad' })
  alojamientoId: string;

  @Matches(/^[A-Z0-9_]{2,40}$/, { message: 'tipoHabitacionCodigo debe tener 2 a 40 caracteres A-Z, 0-9 o _' })
  tipoHabitacionCodigo: string;

  @Matches(FECHA, { message: 'fechaInicio debe tener el formato YYYY-MM-DD' })
  fechaInicio: string;

  @Matches(FECHA, { message: 'fechaFin debe tener el formato YYYY-MM-DD' })
  fechaFin: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  cantidadHabitaciones?: number;

  @ValidateNested()
  @Type(() => OcupantesV2Dto)
  ocupantes: OcupantesV2Dto;

  @IsOptional()
  @IsIn(REGIMENES)
  regimenSeleccionado?: (typeof REGIMENES)[number];

  @IsOptional()
  @IsUUID()
  cotizacionId?: string;

  @Matches(MONEY, { message: 'totalPagar debe ser un importe Money, por ejemplo "560.00"' })
  totalPagar: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency debe ser un código ISO 4217 de 3 letras en mayúsculas' })
  currency?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PaqueteAplicadoV2Dto)
  paquete?: PaqueteAplicadoV2Dto;

  @IsOptional()
  @IsIn(METODOS_PAGO)
  payment_method?: (typeof METODOS_PAGO)[number];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  payment_reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  saga_id?: string;

  // Deprecado: si viene, debe ser igual a la cabecera Idempotency-Key
  @IsOptional()
  @IsUUID()
  idempotency_key?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HuespedTitularV2Dto)
  huespedTitular?: HuespedTitularV2Dto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerContactV2Dto)
  customer_contact?: CustomerContactV2Dto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HuespedAcompananteV2Dto)
  huespedesAdicionales?: HuespedAcompananteV2Dto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  peticionesEspeciales?: string;

  @IsOptional()
  @Matches(/^[A-Z0-9_]{2,30}$/, { message: 'planTarifaCodigo debe tener 2 a 30 caracteres A-Z, 0-9 o _' })
  planTarifaCodigo?: string;
}

// POST /alojamientos/orders/{orderId}/cancel (CancelOrderRequestV2)
export class CancelarOrdenV2Dto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;

  @IsOptional()
  @IsIn(['SAGA_ORCHESTRATOR', 'CLIENTE', 'ADMIN', 'HOTEL'])
  solicitadoPor?: 'SAGA_ORCHESTRATOR' | 'CLIENTE' | 'ADMIN' | 'HOTEL';
}

// GET /alojamientos/orders (filtros de recuperación de la Saga y conciliación)
export class ListarOrdenesV2Query extends PaginaV2Query {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  saga_id?: string;

  @IsOptional()
  @IsUUID()
  idempotency_key?: string;

  @IsOptional()
  @Matches(/^ORD-HTL-[A-Z0-9]{3,20}$/, { message: 'external_order_id debe tener el formato ORD-HTL-…' })
  external_order_id?: string;

  @IsOptional()
  @IsIn(ESTADOS)
  estado?: (typeof ESTADOS)[number];

  @IsOptional()
  @IsDateString()
  creadoDesde?: string;

  @IsOptional()
  @IsDateString()
  creadoHasta?: string;
}

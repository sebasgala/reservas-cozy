import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Equals,
} from 'class-validator';
import { OrdenStatus } from '../../entities/orden.entity';
import { PaginaMetaDto } from '../../../usuarios/dto/admin/usuario-admin.dto';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// GET /admin/recepcion/reservas
export class FiltroRecepcionQueryDto {
  @ApiPropertyOptional({ enum: OrdenStatus })
  @IsOptional()
  @IsEnum(OrdenStatus, { message: 'debe ser PENDING, CONFIRMED, CHECKED_IN, CHECKED_OUT, POR_LIMPIAR, LIMPIA_LISTA o CANCELLED' })
  estado?: OrdenStatus;

  @ApiPropertyOptional({ description: 'true = vista del mostrador: solo reservas CONFIRMED sin check-in cuya estancia no terminó' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: 'debe ser true o false' })
  pendientesCheckin?: boolean;

  @ApiPropertyOptional({ example: '2026-11-11' })
  @IsOptional()
  @Matches(FECHA, { message: 'debe tener el formato YYYY-MM-DD' })
  llegadaDesde?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(FECHA, { message: 'debe tener el formato YYYY-MM-DD' })
  llegadaHasta?: string;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  alojamientoId?: number;

  @ApiPropertyOptional({ description: 'true para incluir o consultar archivadas; false solo activas', type: Boolean })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: 'debe ser true o false' })
  archivadaRecepcion?: boolean;

  @ApiPropertyOptional({ type: 'integer', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page?: number = 1;

  @ApiPropertyOptional({ type: 'integer', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class MotivoRecepcionDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @MaxLength(300)
  @IsString()
  motivo?: string;
}

// POST /admin/recepcion/reservas/:id/checkin-aprobado
export class AprobarCheckinDto {
  @ApiProperty({ example: '1712345675' })
  @Matches(/^[A-Za-z0-9]{6,13}$/, { message: 'debe tener 6 a 13 caracteres alfanuméricos' })
  documentoPresentado: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 40 })
  @IsInt()
  @Min(1)
  @Max(40)
  huespedesPresentes: number;

  @ApiProperty({ example: 'REC-07' })
  @Matches(/^[A-Za-z0-9._-]{2,30}$/, { message: 'debe tener 2 a 30 caracteres' })
  codigoRecepcionista: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @MaxLength(500)
  @IsString()
  observaciones?: string;

  @ApiProperty({ example: true })
  @Equals(true, { message: 'debes confirmar que verificaste físicamente el documento de identidad' })
  documentoVerificadoFisicamente: boolean;
}

// POST /admin/recepcion/reservas/:id/reasignar-habitacion
export class ReasignarHabitacionDto extends MotivoRecepcionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  habitacionId: string;

  @ApiPropertyOptional({ maxLength: 20, example: '204' })
  @IsOptional()
  @MaxLength(20)
  @Matches(/\S/, { message: 'no puede estar vacío' })
  @IsString()
  etiqueta?: string;
}

// POST /admin/recepcion/reservas/:id/huespedes
export class CambiarHuespedesDto extends MotivoRecepcionDto {
  @ApiProperty({ type: 'integer', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(20)
  adultos: number;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  ninos?: number[];
}

// POST /admin/recepcion/reservas/:id/observaciones
export class CambiarObservacionesDto extends MotivoRecepcionDto {
  @ApiProperty({ maxLength: 500 })
  @MaxLength(500)
  @IsString()
  observaciones: string;
}

// POST /admin/recepcion/reservas/:id/habitacion-limpia (Fase 2: POR_LIMPIAR → LIMPIA_LISTA)
export class MarcarHabitacionListaDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Si se omite, se usa la habitación física asignada en el check-in' })
  @IsOptional()
  @IsUUID('all')
  habitacionFisicaId?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @MaxLength(300)
  @IsString()
  notas?: string;
}

// POST /admin/recepcion/reservas/:id/archivar (Fase 2: saca del tablero una reserva CANCELLED o LIMPIA_LISTA)
export class ArchivarReservaDto extends MotivoRecepcionDto {}

// POST /admin/recepcion/reservas/:id/early-checkin
export class AutorizarEarlyCheckinDto extends MotivoRecepcionDto {
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: true })
  desde?: string;
}

export class TitularRecepcionDto {
  @ApiProperty() nombre: string;
  @ApiProperty() email: string;
  @ApiPropertyOptional({ nullable: true }) tipoDocumento: string | null;
  @ApiPropertyOptional({ nullable: true }) identificacion: string | null;
  @ApiProperty() documentoRegistrado: boolean;
}

export class ReservaRecepcionDto {
  @ApiProperty({ format: 'uuid' }) orderId: string;
  @ApiProperty() locator: string;
  @ApiProperty() codigoReserva: string;
  @ApiProperty({ enum: OrdenStatus }) estado: OrdenStatus;
  @ApiProperty({ type: 'integer' }) alojamientoId: number;
  @ApiProperty() alojamientoNombre: string;
  @ApiProperty({ format: 'uuid' }) habitacionId: string;
  @ApiProperty() habitacionNombre: string;
  @ApiPropertyOptional({ nullable: true }) habitacionAsignada: string | null;
  @ApiProperty() llegada: string;
  @ApiProperty() salida: string;
  @ApiProperty({ type: 'integer' }) noches: number;
  @ApiProperty({ type: 'integer' }) habitaciones: number;
  @ApiProperty({ type: () => TitularRecepcionDto }) titular: TitularRecepcionDto;
  @ApiProperty() huespedes: { adultos: number; ninos: number[] };
  @ApiPropertyOptional({ nullable: true }) observaciones: string | null;
  @ApiProperty() earlyCheckin: { autorizado: boolean; desde: string | null };
  @ApiProperty({ format: 'date-time' }) checkinHabilitadoDesde: string;
  @ApiProperty({ format: 'date-time' }) checkinCierraEn: string;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) checkInEn: string | null;
  @ApiProperty() archivadaRecepcion: boolean;
}

export class ReservasRecepcionPaginadasDto {
  @ApiProperty({ type: () => [ReservaRecepcionDto] }) data: ReservaRecepcionDto[];
  @ApiProperty({ type: () => PaginaMetaDto }) meta: PaginaMetaDto;
}

export class ContextoRecepcionDto {
  @ApiPropertyOptional({ type: 'integer', nullable: true }) alojamientoId: number | null;
  @ApiPropertyOptional({ nullable: true }) alojamientoNombre: string | null;
  @ApiPropertyOptional({ nullable: true }) alojamientoCodigo: string | null;
}

export class HabitacionReasignableDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() nombre: string;
  @ApiProperty() tipo: string;
  @ApiProperty() actual: boolean;
}

export class AuditoriaRecepcionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: 'integer' }) alojamientoId: number;
  @ApiProperty({ format: 'uuid' }) reservaId: string;
  @ApiProperty({ format: 'uuid' }) usuarioId: string;
  @ApiProperty() rol: string;
  @ApiProperty() accion: string;
  @ApiPropertyOptional({ nullable: true }) motivo: string | null;
  @ApiPropertyOptional({ nullable: true }) datosPrevios: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) datosNuevos: Record<string, unknown> | null;
  @ApiProperty({ format: 'date-time' }) creadoEn: string;
}

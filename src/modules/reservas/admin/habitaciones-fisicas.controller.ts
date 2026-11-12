import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EstadoLimpieza, HabitacionFisica } from '../entities/habitacion-fisica.entity';
import { RolUsuario, UsuarioSesion as Usuario } from '../../usuarios/usuarios.contrato';
import { ProblemDetailsFilter } from '../../comun/problems/problem-details.filter';
import { respuestaProblema } from '../../comun/problems/respuestas-swagger';
import { idUuid, validacionAdmin } from '../../comun/problems/validacion.pipes';
import { AislamientoAlojamientoGuard } from '../../usuarios/seguridad/aislamiento-alojamiento.guard';
import { JwtAuthGuard } from '../../usuarios/seguridad/jwt-auth.guard';
import { AlojamientoActual, Roles, UsuarioActual } from '../../usuarios/seguridad/roles.decorator';
import { RolesGuard } from '../../usuarios/seguridad/roles.guard';
import { ActualizarLimpiezaDto, CrearHabitacionFisicaDto, HabitacionesFisicasService } from './habitaciones-fisicas.service';

export class CrearHabitacionFisicaBodyDto implements CrearHabitacionFisicaDto {
  @ApiProperty({ format: 'uuid', description: 'Id del tipo de habitación del catálogo' })
  @IsUUID('all')
  tipoHabitacionId: string;

  @ApiProperty({ maxLength: 20, example: '204', description: 'Número o etiqueta visible (ej: 204, Villa-3)' })
  @MaxLength(20)
  @Matches(/\S/, { message: 'no puede estar vacío' })
  @IsString()
  numero: string;
}

export class ActualizarLimpiezaBodyDto implements ActualizarLimpiezaDto {
  @ApiProperty({ enum: EstadoLimpieza })
  @IsEnum(EstadoLimpieza)
  estadoLimpieza: EstadoLimpieza;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @MaxLength(300)
  @IsString()
  motivo?: string;
}

@ApiTags('Interno - Recepción - Habitaciones Físicas')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard, AislamientoAlojamientoGuard)
@Roles(RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
@UsePipes(validacionAdmin())
@UseFilters(ProblemDetailsFilter)
@Controller('admin/recepcion/habitaciones-fisicas')
export class HabitacionesFisicasController {
  constructor(private readonly service: HabitacionesFisicasService) {}

  @Get()
  @Roles(RolUsuario.RECEPCION, RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
  @ApiOperation({ summary: 'Lista habitaciones físicas activas del alojamiento' })
  @ApiResponse({ status: 200, type: [HabitacionFisica] })
  @ApiResponse(respuestaProblema(401, 'UNAUTHORIZED'))
  @ApiResponse(respuestaProblema(403, 'FORBIDDEN'))
  listar(@AlojamientoActual() alojamientoId: number | null) {
    return this.service.listar(alojamientoId);
  }

  @Post()
  @ApiOperation({ summary: 'Registra una habitación física (activa controla_limpieza si es la primera)' })
  @ApiResponse({ status: 201, type: HabitacionFisica })
  @ApiResponse(respuestaProblema(400, 'Datos inválidos o tipo de habitación inexistente'))
  @ApiResponse(respuestaProblema(401, 'UNAUTHORIZED'))
  @ApiResponse(respuestaProblema(403, 'FORBIDDEN: solo administrador o superadmin'))
  @ApiResponse(respuestaProblema(409, 'Número duplicado en el alojamiento'))
  crear(@AlojamientoActual() alojamientoId: number | null, @Body() dto: CrearHabitacionFisicaBodyDto) {
    return this.service.crear(alojamientoId, dto);
  }

  @Post(':id/limpieza')
  @HttpCode(HttpStatus.OK)
  @Roles(RolUsuario.RECEPCION, RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
  @ApiOperation({ summary: 'Cambia el estado de limpieza y deja historial' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: HabitacionFisica })
  @ApiResponse(respuestaProblema(400, 'Estado inválido'))
  @ApiResponse(respuestaProblema(401, 'UNAUTHORIZED'))
  @ApiResponse(respuestaProblema(403, 'FORBIDDEN'))
  @ApiResponse(respuestaProblema(404, 'Habitación no encontrada'))
  actualizarLimpieza(
    @Param('id', idUuid('id')) id: string,
    @AlojamientoActual() alojamientoId: number | null,
    @Body() dto: ActualizarLimpiezaBodyDto,
    @UsuarioActual() usuario: Usuario,
  ) {
    return this.service.actualizarLimpieza(alojamientoId, id, dto, usuario);
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AprobarCheckinDto,
  ArchivarReservaDto,
  AuditoriaRecepcionDto,
  AutorizarEarlyCheckinDto,
  CambiarHuespedesDto,
  CambiarObservacionesDto,
  ContextoRecepcionDto,
  FiltroRecepcionQueryDto,
  HabitacionReasignableDto,
  MarcarHabitacionListaDto,
  ReasignarHabitacionDto,
  ReservaRecepcionDto,
  ReservasRecepcionPaginadasDto,
} from '../dto/admin/recepcion.dto';
import { RolUsuario, UsuarioSesion as Usuario } from '../../usuarios/usuarios.contrato';
import { ProblemDetailsFilter } from '../../comun/problems/problem-details.filter';
import { respuestaProblema } from '../../comun/problems/respuestas-swagger';
import { idUuid, validacionAdmin } from '../../comun/problems/validacion.pipes';
import { ahoraDe } from '../../comun/v2/reloj-prueba';
import { Reloj } from '../../comun/v2/reloj';
import { AislamientoAlojamientoGuard } from '../../usuarios/seguridad/aislamiento-alojamiento.guard';
import { JwtAuthGuard } from '../../usuarios/seguridad/jwt-auth.guard';
import { Roles, UsuarioActual } from '../../usuarios/seguridad/roles.decorator';
import { RolesGuard } from '../../usuarios/seguridad/roles.guard';
import { RecepcionService } from './recepcion.service';

const R401 = respuestaProblema(401, 'UNAUTHORIZED');
const R403 = respuestaProblema(403, 'FORBIDDEN: se necesita rol recepción, administrador o superadmin');
const R404 = respuestaProblema(404, 'NOT_FOUND: la reserva no existe o es de otro alojamiento');
const R409 = respuestaProblema(409, 'INVALID_STATE_TRANSITION / CHECKIN_TIME_NOT_REACHED / ROOM_NOT_AVAILABLE');

@ApiTags('Interno - Recepción')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard, AislamientoAlojamientoGuard)
@Roles(RolUsuario.RECEPCION, RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
@UsePipes(validacionAdmin())
@UseFilters(ProblemDetailsFilter)
@Controller('admin/recepcion')
export class RecepcionController {
  constructor(
    private readonly recepcion: RecepcionService,
    private readonly reloj: Reloj,
  ) {}

  @Get('contexto')
  @ApiOperation({ summary: 'Alojamiento de la sesión (encabezado de recepción)' })
  @ApiResponse({ status: 200, type: ContextoRecepcionDto })
  contexto(@UsuarioActual() usuario: Usuario) {
    return this.recepcion.contexto(usuario);
  }

  @Get('reservas')
  @ApiOperation({ summary: 'Reservas del alojamiento del token (R6)' })
  @ApiResponse({ status: 200, type: ReservasRecepcionPaginadasDto })
  @ApiResponse(respuestaProblema(400, 'Filtros inválidos'))
  @ApiResponse(R401)
  @ApiResponse(R403)
  listar(@Req() req: Request, @Query() filtro: FiltroRecepcionQueryDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.listar(filtro, usuario, ahoraDe(this.reloj, req));
  }

  @Get('reservas/:id/habitaciones')
  @ApiOperation({ summary: 'Habitaciones reasignables del alojamiento (R8)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: [HabitacionReasignableDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  habitaciones(@Param('id', idUuid('id')) id: string, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.habitacionesReasignables(id, usuario);
  }

  @Get('reservas/:id/auditoria')
  @ApiOperation({ summary: 'Auditoría local de recepción de una reserva' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: [AuditoriaRecepcionDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  auditoria(@Param('id', idUuid('id')) id: string, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.auditoriaDe(id, usuario);
  }

  @Post('reservas/:id/checkin-aprobado')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar el check-in en mostrador (CONFIRMED → CHECKED_IN, R7)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(respuestaProblema(400, 'Datos inválidos o documento que no coincide'))
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  aprobarCheckin(@Req() req: Request, @Param('id', idUuid('id')) id: string, @Body() dto: AprobarCheckinDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.aprobarCheckin(id, dto, usuario, ahoraDe(this.reloj, req));
  }

  @Post('reservas/:id/reasignar-habitacion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reasignar la habitación física (R8)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  reasignarHabitacion(@Param('id', idUuid('id')) id: string, @Body() dto: ReasignarHabitacionDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.reasignarHabitacion(id, dto, usuario);
  }

  @Post('reservas/:id/huespedes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar el número de huéspedes registrados (R8)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  cambiarHuespedes(@Param('id', idUuid('id')) id: string, @Body() dto: CambiarHuespedesDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.cambiarHuespedes(id, dto, usuario);
  }

  @Post('reservas/:id/observaciones')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar las observaciones del huésped (R8)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  cambiarObservaciones(@Param('id', idUuid('id')) id: string, @Body() dto: CambiarObservacionesDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.cambiarObservaciones(id, dto, usuario);
  }

  @Post('reservas/:id/early-checkin')
  @HttpCode(HttpStatus.OK)
  @Roles(RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
  @ApiOperation({ summary: 'Autorizar early check-in (solo administrador o superadmin)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(respuestaProblema(403, 'FORBIDDEN: la recepción no autoriza early check-in'))
  @ApiResponse(R404)
  @ApiResponse(R409)
  autorizarEarlyCheckin(@Req() req: Request, @Param('id', idUuid('id')) id: string, @Body() dto: AutorizarEarlyCheckinDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.autorizarEarlyCheckin(id, dto, usuario, ahoraDe(this.reloj, req));
  }

  @Post('reservas/:id/habitacion-limpia')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar la habitación como limpia tras el check-out (POR_LIMPIAR → LIMPIA_LISTA, Fase 2)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  marcarHabitacionLista(@Req() req: Request, @Param('id', idUuid('id')) id: string, @Body() dto: MarcarHabitacionListaDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.marcarHabitacionLista(id, dto, usuario, ahoraDe(this.reloj, req));
  }

  @Post('reservas/:id/archivar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archivar la reserva y sacarla del tablero (solo CANCELLED o LIMPIA_LISTA, Fase 2)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: ReservaRecepcionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  archivarReserva(@Param('id', idUuid('id')) id: string, @Body() dto: ArchivarReservaDto, @UsuarioActual() usuario: Usuario) {
    return this.recepcion.archivarReservaRecepcion(id, usuario, dto.motivo);
  }
}

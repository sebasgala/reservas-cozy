import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConsultarReservaDto, FiltroReservasQueryDto, ReservasPaginadasDto } from './dto/admin/reserva-cuenta.dto';
import { OrderDetailDto } from './dto/order-detail.dto';
import { UsuarioSesion as Usuario } from '../usuarios/usuarios.contrato';
import { OrdenesService } from './ordenes.service';
import { ProblemDetailsFilter } from '../comun/problems/problem-details.filter';
import { respuestaProblema } from '../comun/problems/respuestas-swagger';
import { validacionAdmin } from '../comun/problems/validacion.pipes';
import { JwtAuthGuard } from '../usuarios/seguridad/jwt-auth.guard';
import { LimiteIntentosPorIpGuard } from '../usuarios/seguridad/limite-intentos.guard';
import { UsuarioActual } from '../usuarios/seguridad/roles.decorator';

// Reservas de la cuenta del cliente (rutas internas /cuenta/reservas y /cuenta/consultar-reserva). Fase 8.0: viven en
// reservas; el perfil (/cuenta/perfil) se queda en usuarios.
@ApiTags('Interno - Cuenta')
@UsePipes(validacionAdmin())
@UseFilters(ProblemDetailsFilter)
@Controller('cuenta')
export class CuentaReservasController {
  constructor(private readonly ordenesService: OrdenesService) {}

  @Get('reservas')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Mis reservas',
    description: 'Las órdenes hechas con mi sesión iniciada (clienteId = yo), más recientes primero. Filtro opcional por estado.',
  })
  @ApiResponse({ status: 200, description: 'Página de mis reservas', type: ReservasPaginadasDto })
  @ApiResponse(respuestaProblema(400, 'Filtros inválidos'))
  @ApiResponse(respuestaProblema(401, 'UNAUTHORIZED: falta el token o no es válido'))
  reservas(@Query() filtro: FiltroReservasQueryDto, @UsuarioActual() usuario: Usuario) {
    return this.ordenesService.listarDeCliente(usuario.id, filtro.estado, filtro.page ?? 1, filtro.limit ?? 10);
  }

  @Get('reservas/:localizador')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Una de mis reservas, por su localizador',
    description: 'Solo las órdenes hechas con mi sesión (clienteId = yo). Si el localizador es de otra persona, responde 404 igual que si no existiera.',
  })
  @ApiParam({ name: 'localizador', example: 'K7M2Q9XR' })
  @ApiResponse({ status: 200, description: 'Detalle de la reserva', type: OrderDetailDto })
  @ApiResponse(respuestaProblema(401, 'UNAUTHORIZED: falta el token o no es válido'))
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: no tienes una reserva con ese localizador'))
  reserva(@Param('localizador') localizador: string, @UsuarioActual() usuario: Usuario) {
    return this.ordenesService.obtenerDeCliente(usuario.id, localizador);
  }

  @Post('consultar-reserva')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LimiteIntentosPorIpGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Consultar una reserva hecha sin cuenta',
    description:
      'Localizador + correo con el que se reservó. Devuelve lo mismo que GET /orders/{id}. Si el localizador existe pero el ' +
      'correo no coincide, responde 404 igual que si no existiera. Máximo 10 intentos por minuto por IP.',
  })
  @ApiResponse({ status: 200, description: 'Detalle de la reserva', type: OrderDetailDto })
  @ApiResponse(respuestaProblema(400, 'Datos inválidos'))
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: no hay una reserva con ese localizador y correo'))
  @ApiResponse(respuestaProblema(429, 'RATE_LIMIT_EXCEEDED: demasiados intentos; cabecera Retry-After'))
  consultarReserva(@Body() dto: ConsultarReservaDto) {
    return this.ordenesService.consultarPorLocalizador(dto.localizador, dto.correo);
  }
}

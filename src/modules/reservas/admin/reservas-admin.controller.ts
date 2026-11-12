import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FiltroReservasAdminQueryDto, ReservasAdminPaginadasDto } from '../dto/admin/reserva-cuenta.dto';
import { OrderDetailDto } from '../dto/order-detail.dto';
import { RolUsuario, UsuarioSesion as Usuario } from '../../usuarios/usuarios.contrato';
import { OrdenesService } from '../ordenes.service';
import { ProblemDetailsFilter } from '../../comun/problems/problem-details.filter';
import { respuestaProblema } from '../../comun/problems/respuestas-swagger';
import { idUuid, validacionAdmin } from '../../comun/problems/validacion.pipes';
import { AislamientoAlojamientoGuard } from '../../usuarios/seguridad/aislamiento-alojamiento.guard';
import { JwtAuthGuard } from '../../usuarios/seguridad/jwt-auth.guard';
import { Roles, UsuarioActual } from '../../usuarios/seguridad/roles.decorator';
import { RolesGuard } from '../../usuarios/seguridad/roles.guard';
import { AccesoReservasService } from './acceso-reservas.service';

const R401 = respuestaProblema(401, 'UNAUTHORIZED: falta el token o no es válido');
const R403 = respuestaProblema(403, 'FORBIDDEN: se necesita rol administrador o superadmin');

// Reservas vistas por el administrador: solo las de SUS alojamientos (el superadmin, todas).
@ApiTags('Interno - Admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard, AislamientoAlojamientoGuard)
@Roles(RolUsuario.ADMINISTRADOR, RolUsuario.SUPERADMIN)
@UsePipes(validacionAdmin())
@UseFilters(ProblemDetailsFilter)
@Controller('admin/reservas')
export class ReservasAdminController {
  constructor(
    private readonly ordenesService: OrdenesService,
    private readonly acceso: AccesoReservasService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar las reservas de mis alojamientos', description: 'Filtros opcionales por estado y alojamiento. Más recientes primero.' })
  @ApiResponse({ status: 200, description: 'Página de reservas, con los datos de quien reservó', type: ReservasAdminPaginadasDto })
  @ApiResponse(respuestaProblema(400, 'Filtros inválidos'))
  @ApiResponse(R401)
  @ApiResponse(R403)
  listar(@Query() filtro: FiltroReservasAdminQueryDto, @UsuarioActual() usuario: Usuario) {
    return this.ordenesService.listarDeAlojamientos(
      this.acceso.propietarioDelFiltro(usuario) ?? null,
      { estado: filtro.estado, alojamientoId: this.acceso.alojamientoDelFiltro(usuario, filtro.alojamientoId) },
      filtro.page ?? 1,
      filtro.limit ?? 10,
    );
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar una reserva de mi alojamiento',
    description: 'Misma lógica que la cancelación del contrato: devuelve los cupos una sola vez. Repetirla no devuelve cupos otra vez. Deja fila de auditoría.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'order_id' })
  @ApiResponse({ status: 200, description: 'Reserva cancelada', type: OrderDetailDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(respuestaProblema(404, 'NOT_FOUND: la reserva no existe o es de un alojamiento ajeno'))
  async cancelar(@Param('id', idUuid('id')) id: string, @UsuarioActual() usuario: Usuario) {
    await this.acceso.orden(id, usuario);
    return this.ordenesService.cancelar(id, { usuarioId: usuario.id });
  }
}

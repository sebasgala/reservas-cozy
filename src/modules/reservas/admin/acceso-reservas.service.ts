import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogoPuerto } from '../../catalogo/catalogo.puerto';
import { esUuid } from '../../comun/alojamientos-consulta.utils';
import { RecursoNoEncontradoException } from '../../comun/problems/problem-details.exceptions';
import { alojamientoDeSesion, RolUsuario, UsuarioSesion } from '../../usuarios/usuarios.contrato';
import { Orden } from '../entities/orden.entity';
import { CONEXION } from '../../../database/conexiones';

// Autorización del panel sobre las reservas (Bloque R):
//   superadmin                 todas.
//   administrador / recepción  las de su alojamiento (alojamientoId del JWT).
//   administrador sin JWT      sigue viendo las de los alojamientos de los que es propietario.
// Fuera de su alcance responde 404.
@Injectable()
export class AccesoReservasService {
  constructor(
    @InjectRepository(Orden, CONEXION.reservas) private readonly ordenes: Repository<Orden>,
    private readonly catalogo: CatalogoPuerto,
  ) {}

  async orden(id: string, usuario: UsuarioSesion): Promise<Orden> {
    const orden = esUuid(id) ? await this.ordenes.findOneBy({ id }) : null;
    if (!orden || !(await this.puedeOperar(orden, usuario))) {
      const detalle = `La orden ${id} no existe`;
      throw new RecursoNoEncontradoException(detalle, [{ name: 'id', reason: detalle }]);
    }
    return orden;
  }

  async puedeOperar(orden: Pick<Orden, 'alojamientoId'>, usuario: UsuarioSesion): Promise<boolean> {
    if (usuario.rol === RolUsuario.SUPERADMIN) return true;
    const propio = alojamientoDeSesion(usuario);
    if (propio !== undefined) return orden.alojamientoId === propio;
    if (usuario.rol !== RolUsuario.ADMINISTRADOR) return false;
    return (await this.catalogo.alojamientoPorId(orden.alojamientoId))?.propietarioId === usuario.id;
  }

  // Filtro de propietario para listados (cuentas anteriores al Bloque R sin alojamiento en token)
  propietarioDelFiltro(usuario: UsuarioSesion): string | undefined {
    if (usuario.rol === RolUsuario.SUPERADMIN || alojamientoDeSesion(usuario) !== undefined) return undefined;
    return usuario.id;
  }

  // Alojamiento con que se filtra un listado; el del token manda sobre cualquier parámetro recibido.
  alojamientoDelFiltro(usuario: UsuarioSesion, pedido?: number): number | undefined {
    const propio = alojamientoDeSesion(usuario);
    if (propio === undefined) return pedido;
    if (pedido !== undefined && pedido !== propio) {
      const detalle = `Alojamiento ${pedido} no existe`;
      throw new RecursoNoEncontradoException(detalle, [{ name: 'alojamientoId', reason: detalle }]);
    }
    return propio;
  }
}

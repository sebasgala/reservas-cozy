import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogoPuerto } from '../../catalogo/catalogo.puerto';
import { esUuid } from '../../comun/alojamientos-consulta.utils';
import { RecursoNoEncontradoException } from '../../comun/problems/problem-details.exceptions';
import { RolUsuario, UsuarioSesion } from '../../usuarios/usuarios.contrato';
import { Orden } from '../entities/orden.entity';
import { CONEXION } from '../../../database/conexiones';

// Autorización del panel sobre las reservas (fase 8.0; antes estaba en AccesoAdminService del catálogo):
// el superadmin ve todas; un administrador, las de sus alojamientos (de quién es cada uno lo dice el catálogo).
// Fuera de su alcance responde 404, igual que si no existiera: así no se revela que existe.
@Injectable()
export class AccesoReservasService {
  constructor(
    @InjectRepository(Orden, CONEXION.reservas) private readonly ordenes: Repository<Orden>,
    private readonly catalogo: CatalogoPuerto,
  ) {}

  async orden(id: string, usuario: UsuarioSesion): Promise<Orden> {
    const orden = esUuid(id) ? await this.ordenes.findOneBy({ id }) : null;
    const administrable =
      orden && (usuario.rol === RolUsuario.SUPERADMIN || (usuario.rol === RolUsuario.ADMINISTRADOR && (await this.catalogo.alojamientoPorId(orden.alojamientoId))?.propietarioId === usuario.id));
    if (!administrable) {
      const detalle = `La orden ${id} no existe`;
      throw new RecursoNoEncontradoException(detalle, [{ name: 'id', reason: detalle }]);
    }
    return orden;
  }

  // Filtro de listados: undefined = sin filtro (superadmin); si no, solo los alojamientos del administrador
  propietarioDelFiltro(usuario: UsuarioSesion): string | undefined {
    return usuario.rol === RolUsuario.SUPERADMIN ? undefined : usuario.id;
  }
}

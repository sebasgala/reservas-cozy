import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RolUsuario } from '../entities/usuario.entity';
import { NoAutenticadoException, ProhibidoException, RecursoNoEncontradoException } from '../../comun/problems/problem-details.exceptions';
import { PeticionAutenticada } from './seguridad.tipos';

// Bloque R (R3): aislamiento por alojamiento. Va SIEMPRE después de JwtAuthGuard (y de RolesGuard).
//   superadmin                      → sin restricción.
//   administrador / recepción       → si la ruta, la query o el cuerpo traen `alojamientoId`, debe ser el del token.
//   recepción sin alojamiento       → 403 (no puede operar nada).
//   administrador sin alojamiento   → cuenta anterior al Bloque R: se deja pasar.
@Injectable()
export class AislamientoAlojamientoGuard implements CanActivate {
  canActivate(contexto: ExecutionContext): boolean {
    const peticion = contexto.switchToHttp().getRequest<PeticionAutenticada>();
    const { usuario } = peticion;
    if (!usuario) throw new NoAutenticadoException();
    if (usuario.rol === RolUsuario.SUPERADMIN) return true;
    if (usuario.alojamientoId === null || usuario.alojamientoId === undefined) {
      if (usuario.rol === RolUsuario.RECEPCION) throw new ProhibidoException('Tu cuenta de recepción no tiene alojamiento asignado');
      return true;
    }
    for (const pedido of alojamientosPedidos(peticion)) {
      if (pedido !== usuario.alojamientoId) {
        const detalle = `Alojamiento ${pedido} no existe`;
        throw new RecursoNoEncontradoException(detalle, [{ name: 'alojamientoId', reason: detalle }]);
      }
    }
    return true;
  }
}

function alojamientosPedidos(peticion: PeticionAutenticada): number[] {
  const fuentes = [peticion.params?.alojamientoId, peticion.query?.alojamientoId, (peticion.body as { alojamientoId?: unknown } | undefined)?.alojamientoId];
  return fuentes
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

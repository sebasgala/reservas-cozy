import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RolUsuario } from '../entities/usuario.entity';
import { PeticionAutenticada, SesionJwt } from './seguridad.tipos';

export const CLAVE_ROLES = 'roles';

// Roles que pueden entrar a la ruta o al controlador. Sin @Roles, basta con haber iniciado sesión.
export const Roles = (...roles: RolUsuario[]) => SetMetadata(CLAVE_ROLES, roles);

// Sesión del token de la petición: id, rol, estado y alojamiento (solo en rutas con JwtAuthGuard).
export const UsuarioActual = createParamDecorator((_: unknown, contexto: ExecutionContext): SesionJwt => {
  return contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario;
});

// Alojamiento del token (Bloque R): null para superadmin y cuentas sin alojamiento.
export const AlojamientoActual = createParamDecorator((_: unknown, contexto: ExecutionContext): number | null => {
  return contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario?.alojamientoId ?? null;
});

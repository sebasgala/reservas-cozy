import { RolUsuario, Usuario } from './entities/usuario.entity';

// Contrato de identidad que usuarios ofrece a los otros dominios (fase 8.0).
// Bloque R: incluye alojamientoId (del token); nunca se toma de la petición.
export { RolUsuario };

export type UsuarioSesion = Pick<Usuario, 'id' | 'rol' | 'alojamientoId'>;

// El alojamiento que la sesión puede ver u operar. undefined = sin restricción (superadmin, o administrador sin alojamiento).
export function alojamientoDeSesion(usuario: UsuarioSesion): number | undefined {
  if (usuario.rol === RolUsuario.SUPERADMIN) return undefined;
  return usuario.alojamientoId ?? undefined;
}

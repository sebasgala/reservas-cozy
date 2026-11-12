import { Request } from 'express';
import { EstadoUsuario, RolUsuario } from '../entities/usuario.entity';

// Sesión que el token deja en la petición (fase 8.1): el id, el rol, el estado y el alojamiento con que se emitió.
// JwtAuthGuard solo verifica la firma y el vencimiento: NO lee la cuenta.
// Bloque R (R3): `alojamientoId` es la ÚNICA fuente para filtrar por alojamiento; nunca se toma del cuerpo.
export interface SesionJwt {
  id: string;
  rol: RolUsuario;
  estado: EstadoUsuario;
  alojamientoId: number | null;
}

// Petición ya autenticada: JwtAuthGuard deja aquí la sesión que trae el token.
export interface PeticionAutenticada extends Request {
  usuario: SesionJwt;
}

// Contenido del JWT. Un token anterior al Bloque R (sin `alojamientoId`) se acepta como cuenta sin alojamiento.
export interface CargaJwt {
  sub: string;
  rol: RolUsuario;
  estado: EstadoUsuario;
  alojamientoId?: number | null;
}

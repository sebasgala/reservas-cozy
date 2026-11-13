import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CatalogoPuerto } from '../../catalogo/catalogo.puerto';
import { ConflictoException, ConsultaInvalidaException, RecursoNoEncontradoException } from '../../comun/problems/problem-details.exceptions';
import { UsuarioSesion } from '../../usuarios/usuarios.contrato';
import { EstadoLimpieza, HabitacionFisica } from '../entities/habitacion-fisica.entity';
import { HistorialLimpieza } from '../entities/historial-limpieza.entity';
import { CONEXION } from '../../../database/conexiones';

export interface CrearHabitacionFisicaDto {
  tipoHabitacionId: string;
  numero: string;
}

export interface ActualizarLimpiezaDto {
  estadoLimpieza: EstadoLimpieza;
  motivo?: string;
}

@Injectable()
export class HabitacionesFisicasService {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly catalogo: CatalogoPuerto,
  ) {}

  // Lista habitaciones físicas del alojamiento de la sesión
  async listar(alojamientoId: number | null): Promise<HabitacionFisica[]> {
    if (alojamientoId == null || !Number.isFinite(alojamientoId)) {
      return [];
    }
    return this.dataSource.getRepository(HabitacionFisica).find({
      where: { alojamientoId, activa: true },
      order: { numero: 'ASC' },
    });
  }

  // Registra una habitación física; activa controla_limpieza si es la primera
  async crear(alojamientoId: number, dto: CrearHabitacionFisicaDto): Promise<HabitacionFisica> {
    const habitacion = await this.catalogo.habitaciones({ alojamientoId, ids: [dto.tipoHabitacionId] });
    if (!habitacion.length) {
      throw new RecursoNoEncontradoException('El tipo de habitación no existe en este alojamiento', [{ name: 'tipoHabitacionId', reason: 'no existe' }]);
    }
    return this.dataSource.transaction(async (manager) => {
      const hf = manager.create(HabitacionFisica, {
        alojamientoId,
        tipoHabitacionId: dto.tipoHabitacionId,
        numero: dto.numero.trim(),
        estadoLimpieza: EstadoLimpieza.LIMPIA,
        activa: true,
      });
      await manager.save(hf);
      return hf;
    });
  }

  // Cambia el estado de limpieza y deja historial
  async actualizarLimpieza(alojamientoId: number, habitacionId: string, dto: ActualizarLimpiezaDto, usuario: UsuarioSesion): Promise<HabitacionFisica> {
    return this.dataSource.transaction(async (manager) => {
      const hf = await manager.findOneBy(HabitacionFisica, { id: habitacionId, alojamientoId, activa: true });
      if (!hf) throw new RecursoNoEncontradoException('La habitación física no existe', [{ name: 'id', reason: 'no existe' }]);
      if (hf.estadoLimpieza === dto.estadoLimpieza) return hf;
      // OCUPADA la gobiernan el check-in y el check-out: el control interno no la toca ni la libera a mano
      if (hf.estadoLimpieza === EstadoLimpieza.OCUPADA || dto.estadoLimpieza === EstadoLimpieza.OCUPADA) {
        throw new ConflictoException('INVALID_STATE_TRANSITION', 'El estado OCUPADA lo gobiernan el check-in y el check-out de la reserva', [{ name: 'estadoLimpieza', reason: 'no editable manualmente' }]);
      }
      const anterior = hf.estadoLimpieza;
      hf.estadoLimpieza = dto.estadoLimpieza;
      await manager.save(hf);
      await manager.insert(HistorialLimpieza, {
        habitacionFisicaId: hf.id,
        reservaId: null,
        usuarioId: usuario.id,
        estadoAnterior: anterior,
        estadoNuevo: dto.estadoLimpieza,
        motivo: dto.motivo?.trim() || null,
      });
      return hf;
    });
  }

  // Busca la primera habitación LIMPIA del tipo correcto (para el check-in); null si no hay
  async buscarLimpia(manager: EntityManager, alojamientoId: number, tipoHabitacionId: string): Promise<HabitacionFisica | null> {
    return manager
      .getRepository(HabitacionFisica)
      .createQueryBuilder('hf')
      .setLock('pessimistic_write')
      .where('hf.alojamientoId = :alojamientoId', { alojamientoId })
      .andWhere('hf.tipoHabitacionId = :tipoHabitacionId', { tipoHabitacionId })
      .andWhere('hf.estadoLimpieza = :estado', { estado: EstadoLimpieza.LIMPIA })
      .andWhere('hf.activa = true')
      .orderBy('hf.numero', 'ASC')
      .getOne();
  }

  // Check-in: toma la primera habitación LIMPIA del tipo y la deja OCUPADA con su historial (misma transacción del check-in).
  // Lanza 409 ROOM_NOT_AVAILABLE si no hay ninguna limpia (las SUCIA, EN_LIMPIEZA y en MANTENIMIENTO quedan bloqueadas).
  async asignarYOcupar(manager: EntityManager, alojamientoId: number, tipoHabitacionId: string, reservaId: string, usuarioId: string | null): Promise<HabitacionFisica> {
    const hf = await this.buscarLimpia(manager, alojamientoId, tipoHabitacionId);
    if (!hf) {
      throw new ConflictoException('ROOM_NOT_AVAILABLE', 'No hay habitaciones limpias disponibles para este tipo de habitación. Consulta con recepción.', [{ name: 'habitacionId', reason: 'sin habitación LIMPIA' }]);
    }
    hf.estadoLimpieza = EstadoLimpieza.OCUPADA;
    await manager.save(hf);
    await manager.insert(HistorialLimpieza, { habitacionFisicaId: hf.id, reservaId, usuarioId, estadoAnterior: EstadoLimpieza.LIMPIA, estadoNuevo: EstadoLimpieza.OCUPADA, motivo: 'check-in' });
    return hf;
  }

  // Marca la habitación asignada como SUCIA (en la misma transacción del check-out)
  async marcarSucia(manager: EntityManager, habitacionFisicaId: string, reservaId: string): Promise<void> {
    const hf = await manager.findOneBy(HabitacionFisica, { id: habitacionFisicaId, activa: true });
    if (!hf || hf.estadoLimpieza === EstadoLimpieza.SUCIA) return;
    const anterior = hf.estadoLimpieza;
    hf.estadoLimpieza = EstadoLimpieza.SUCIA;
    await manager.save(hf);
    await manager.insert(HistorialLimpieza, {
      habitacionFisicaId,
      reservaId,
      usuarioId: null,
      estadoAnterior: anterior,
      estadoNuevo: EstadoLimpieza.SUCIA,
      motivo: 'check-out automático',
    });
  }

  // Limpieza terminada: la habitación vuelve a LIMPIA y queda libre para un nuevo check-in (misma transacción que
  // marcarHabitacionLista). Libera el vínculo de ocupación físico que el check-out dejó bloqueado (SUCIA/OCUPADA).
  async marcarLista(manager: EntityManager, habitacionFisicaId: string, reservaId: string | null, usuarioId: string | null, notas?: string): Promise<void> {
    const hf = await manager.findOneBy(HabitacionFisica, { id: habitacionFisicaId, activa: true });
    if (!hf) throw new RecursoNoEncontradoException('La habitación física no existe', [{ name: 'habitacionFisicaId', reason: 'no existe' }]);
    if (hf.estadoLimpieza === EstadoLimpieza.LIMPIA) return;
    const anterior = hf.estadoLimpieza;
    hf.estadoLimpieza = EstadoLimpieza.LIMPIA;
    await manager.save(hf);
    await manager.insert(HistorialLimpieza, {
      habitacionFisicaId,
      reservaId,
      usuarioId,
      estadoAnterior: anterior,
      estadoNuevo: EstadoLimpieza.LIMPIA,
      motivo: notas?.trim() || 'limpieza completada',
    });
  }

  async verificaControlaLimpieza(manager: EntityManager, alojamientoId: number): Promise<boolean> {
    // El alojamiento controla la limpieza desde que registra su primera habitación física activa (tabla propia de reservas;
    // la entidad Alojamiento del catálogo no está registrada en esta conexión)
    return manager.getRepository(HabitacionFisica).exists({ where: { alojamientoId, activa: true } });
  }
}

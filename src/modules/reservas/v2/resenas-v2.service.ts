import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrdenStatus } from '../entities/orden.entity';
import { Resena } from '../entities/resena.entity';
import { PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { nombrePublico } from './checkin';
import { metadataPagina } from '../../comun/v2/dinero';
import { CrearResenaV2Dto } from './dto/estancia-v2.dto';
import { PaginaV2Query } from '../../catalogo/v2/dto/catalogo-v2.dto';
import { noEncontrado, ProblemaV2Exception } from '../../comun/v2/problemas-v2';
import { CatalogoPuerto } from '../../catalogo/catalogo.puerto';
import { OrdenesV2Service } from './ordenes-v2.service';
import { fechaGuayaquil } from '../../comun/v2/reloj';
import { CONEXION } from '../../../database/conexiones';

const CATEGORIAS = ['limpieza', 'confort', 'ubicacion', 'personal', 'relacionCalidadPrecio'] as const;
const UQ_RESENAS_ORDEN = 'UQ_resenas_ordenId';

// Reseñas del contrato v2: GET público; POST solo del titular (CLIENTE) de una reserva CHECKED_OUT, una por reserva.
@Injectable()
export class ResenasV2Service {
  constructor(
    @InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource,
    private readonly ordenes: OrdenesV2Service,
    private readonly catalogo: CatalogoPuerto,
  ) {}

  private async alojamiento(codigo: string): Promise<{ id: number; codigo: string }> {
    const alojamiento = await this.catalogo.alojamientoPorCodigo(codigo, { soloActivo: true });
    if (!alojamiento) throw noEncontrado(`No existe el alojamiento '${codigo}'.`);
    return alojamiento;
  }

  // ListadoResenasResponseV2
  async listar(codigo: string, q: PaginaV2Query) {
    const aloj = await this.alojamiento(codigo);
    const [agregado] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "total", COALESCE(ROUND(AVG("calificacionGlobal"), 1), 0)::float AS "promedio",
              ${CATEGORIAS.map((c) => `ROUND(AVG(("desglose"->>'${c}')::numeric), 1)::float AS "${c}"`).join(', ')}
       FROM "reservas"."resenas" WHERE "alojamientoId" = $1`,
      [aloj.id],
    );
    const filas: Resena[] = await this.dataSource.getRepository(Resena).find({
      where: { alojamientoId: aloj.id },
      relations: { orden: true },
      order: { creadoEn: 'DESC', id: 'ASC' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    });
    const desglosePromedio = Object.fromEntries(CATEGORIAS.filter((c) => agregado[c] !== null).map((c) => [c, agregado[c]]));
    return {
      alojamientoId: aloj.codigo,
      scorePromedio: agregado.promedio,
      totalResenas: agregado.total,
      ...(Object.keys(desglosePromedio).length > 0 && { desglosePromedio }),
      metadata: metadataPagina(agregado.total, q.page, q.limit),
      resenas: filas.map((r) => this.aRespuesta(r)),
    };
  }

  // POST: 201 ResenaUsuarioV2
  async crear(codigo: string, dto: CrearResenaV2Dto, principal: PrincipalV2, ahora: Date) {
    const aloj = await this.alojamiento(codigo);
    const orden = await this.ordenes.buscar(this.dataSource.manager, dto.reservaId);
    // Solo el titular: la reseña de otra persona es un 403, no un 404 (la reserva existe)
    if (orden.clienteId !== principal.usuarioId) throw new ProblemaV2Exception(403, 'FORBIDDEN', 'Esta reserva no es tuya.');
    if (orden.alojamientoId !== aloj.id) throw noEncontrado(`El alojamiento '${codigo}' no tiene la reserva '${dto.reservaId}'.`);
    if (orden.status !== OrdenStatus.CHECKED_OUT) {
      throw new ProblemaV2Exception(409, 'INVALID_STATE_TRANSITION', `Solo se puede reseñar una reserva en estado CHECKED_OUT (la reserva está ${orden.status}).`);
    }
    const repo = this.dataSource.getRepository(Resena);
    if (await repo.existsBy({ ordenId: orden.id })) throw new ProblemaV2Exception(409, 'CONFLICT', 'Ya existe una reseña para esta reserva.');

    const titular = orden.huespedTitular as { nombreCompleto?: string; nacionalidad?: string } | null;
    try {
      const guardada = await repo.save(
        repo.create({
          ordenId: orden.id,
          alojamientoId: aloj.id,
          clienteId: principal.usuarioId ?? null,
          calificacionGlobal: dto.calificacionGlobal,
          desglose: dto.desgloseCalificaciones ? { ...dto.desgloseCalificaciones } : null,
          comentario: dto.comentario.trim(),
          tipoViaje: dto.tipoViaje ?? null,
          autorNombre: nombrePublico(titular?.nombreCompleto ?? `${orden.customerFirstName} ${orden.customerLastName}`),
          autorPais: titular?.nacionalidad?.slice(0, 60) ?? null,
          tipoHabitacion: orden.habitacionNombre.slice(0, 100),
          fecha: fechaGuayaquil(ahora),
        }),
      );
      return this.aRespuesta(guardada);
    } catch (error) {
      // Dos reseñas simultáneas de la misma reserva: gana una y la otra es el mismo 409
      if ((error as { constraint?: string }).constraint === UQ_RESENAS_ORDEN) throw new ProblemaV2Exception(409, 'CONFLICT', 'Ya existe una reseña para esta reserva.');
      throw error;
    }
  }

  // ResenaUsuarioV2: del autor solo sale "Nombre I." y el país
  private aRespuesta(r: Resena) {
    return {
      id: `REV-ALO-${r.id}`,
      autorNombre: r.autorNombre,
      ...(r.autorPais && { autorPais: r.autorPais }),
      calificacionGlobal: Number(r.calificacionGlobal),
      ...(r.desglose && Object.keys(r.desglose).length > 0 && { desgloseCalificaciones: r.desglose }),
      fecha: r.fecha,
      comentario: r.comentario,
      ...(r.tipoViaje && { tipoViaje: r.tipoViaje }),
      estadiaVerificada: true,
      ...(r.tipoHabitacion && { tipoHabitacionAlojado: r.tipoHabitacion }),
    };
  }
}

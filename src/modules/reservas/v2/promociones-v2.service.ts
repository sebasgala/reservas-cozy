import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { esFechaValida } from '../../comun/alojamientos-consulta.utils';
import { nodoCodigo } from '../../comun/codigos';
import { PromocionContrato } from '../entities/promocion-contrato.entity';
import { PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { ContratoPromocionesV2Dto } from './dto/estancia-v2.dto';
import { AcuerdoPromociones, normalizarDestino, validarAcuerdoNuevo } from './promociones';
import { peticionInvalida, ProblemaV2Exception } from '../../comun/v2/problemas-v2';
import { fechaGuayaquil } from '../../comun/v2/reloj';
import { CONEXION } from '../../../database/conexiones';

// Acuerdo B2B de promociones y combos (contrato v2 §3):
//   GET /alojamientos/promociones/contrato   el acuerdo vigente. Sin acuerdo formalizado: no acepta promociones.
//   PUT /alojamientos/promociones/contrato   lo formaliza o actualiza (solo ADMIN). Idempotente: el mismo cuerpo deja el mismo estado.
// Cada orden con `paquete` se valida contra este acuerdo (OrdenesV2Service).
@Injectable()
export class PromocionesV2Service {
  constructor(@InjectDataSource(CONEXION.reservas) private readonly dataSource: DataSource) {}

  // El acuerdo tal como lo ve la validación de órdenes; null si nunca se formalizó
  async acuerdo(manager: EntityManager): Promise<AcuerdoPromociones | null> {
    const fila = await manager.findOneBy(PromocionContrato, { id: 1 });
    return fila ? { permitePromociones: fila.permitePromociones, porcentajeMaximo: Number(fila.porcentajeMaximo), destinos: fila.destinos, vigenciaDesde: fila.vigenciaDesde, vigenciaHasta: fila.vigenciaHasta } : null;
  }

  // El acuerdo fuera de una transacción (permitePaquete del catálogo)
  acuerdoActual(): Promise<AcuerdoPromociones | null> {
    return this.acuerdo(this.dataSource.manager);
  }

  async obtener() {
    return this.aRespuesta(await this.dataSource.manager.findOneBy(PromocionContrato, { id: 1 }));
  }

  // Solo el administrador general o un servicio con el scope alojamientos:admin: el acuerdo vale para todo el nodo y un
  // administrador de un solo hotel no debe poder cambiar el descuento máximo de los demás.
  async formalizar(dto: ContratoPromocionesV2Dto, principal: PrincipalV2, ahora: Date) {
    if (principal.rol === 'ADMIN' && !principal.superadmin) {
      throw new ProblemaV2Exception(403, 'FORBIDDEN', 'El acuerdo B2B es de todo el nodo: solo lo formaliza el administrador general.');
    }
    if (dto.vigencia_hasta && !esFechaValida(dto.vigencia_hasta)) {
      throw peticionInvalida([{ name: 'vigencia_hasta', reason: 'debe ser una fecha válida YYYY-MM-DD' }]);
    }
    const hoy = fechaGuayaquil(ahora);
    validarAcuerdoNuevo(dto.permite_promociones, dto.porcentaje_descuento_maximo, dto.vigencia_hasta, hoy);

    const destinos: string[] = [];
    for (const d of dto.destinos_habilitados ?? []) {
      const nombre = d.trim();
      if (nombre && !destinos.some((x) => normalizarDestino(x) === normalizarDestino(nombre))) destinos.push(nombre);
    }
    const contacto = dto.contacto_comercial ? Object.fromEntries(Object.entries(dto.contacto_comercial).filter(([, v]) => v !== undefined && v !== '')) : null;

    return this.dataSource.transaction(async (manager) => {
      const actual = await manager.getRepository(PromocionContrato).createQueryBuilder('p').setLock('pessimistic_write').where('p.id = 1').getOne();
      const nuevo = {
        permitePromociones: dto.permite_promociones,
        porcentajeMaximo: dto.porcentaje_descuento_maximo,
        destinos,
        vigenciaHasta: dto.vigencia_hasta ?? null,
        condicionesCombo: dto.condiciones_combo ?? null,
        contactoComercial: contacto && Object.keys(contacto).length > 0 ? (contacto as Record<string, string>) : null,
      };
      // Mismo cuerpo, mismo estado: no se toca la fila (ni su updated_at). jsonb reordena las claves: se comparan ordenadas.
      const estable = (valor: unknown) => JSON.stringify(valor, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
      const igual =
        actual &&
        actual.permitePromociones === nuevo.permitePromociones &&
        Number(actual.porcentajeMaximo) === nuevo.porcentajeMaximo &&
        estable(actual.destinos) === estable(nuevo.destinos) &&
        actual.vigenciaHasta === nuevo.vigenciaHasta &&
        actual.condicionesCombo === nuevo.condicionesCombo &&
        estable(actual.contactoComercial) === estable(nuevo.contactoComercial);
      if (actual && igual) return this.aRespuesta(actual);
      const fila = manager.create(PromocionContrato, {
        id: 1,
        ...nuevo,
        vigenciaDesde: actual?.vigenciaDesde ?? hoy,
        actualizadoPor: principal.rol === 'SERVICE' ? null : (principal.usuarioId ?? null),
        updatedAt: ahora,
      });
      return this.aRespuesta(await manager.save(fila));
    });
  }

  // ContratoPromocionesResponseV2
  private aRespuesta(fila: PromocionContrato | null) {
    return {
      tienda_id: process.env.TIENDA_ID?.trim() || `proveedor-alojamientos-${nodoCodigo().toLowerCase()}`,
      vertical: 'alojamientos' as const,
      permite_promociones: fila?.permitePromociones ?? false,
      porcentaje_descuento_maximo: Number(fila?.porcentajeMaximo ?? 0),
      destinos_habilitados: fila?.destinos ?? [],
      ...(fila && { vigencia_desde: fila.vigenciaDesde }),
      ...(fila?.vigenciaHasta && { vigencia_hasta: fila.vigenciaHasta }),
      ...(fila?.condicionesCombo && { condiciones_combo: fila.condicionesCombo }),
      // jsonb no conserva el orden de las claves: se devuelve siempre en el orden del contrato
      ...(fila?.contactoComercial && { contacto_comercial: Object.fromEntries(['nombre', 'email', 'telefono'].filter((k) => fila.contactoComercial?.[k] !== undefined).map((k) => [k, fila.contactoComercial![k]])) }),
      ...(fila && { updated_at: new Date(fila.updatedAt).toISOString() }),
    };
  }
}

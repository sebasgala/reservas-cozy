import { Global, Injectable, Module, Optional } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Orden, OrdenStatus } from '../entities/orden.entity';
import { PromocionContrato } from '../entities/promocion-contrato.entity';
import { hoyIso } from '../../comun/alojamientos-consulta.utils';
import { AcuerdoPromocionesVigentes, ConsultaReservasVigentes } from '../../catalogo/reservas-vigentes.puerto';
import { CONEXION } from '../../../database/conexiones';

// Reservas que todavía cuentan: CONFIRMED (o CHECKED_IN) y con la salida posterior a hoy (futuras o en curso).
// Responde la pregunta del catálogo antes de dar de baja una habitación o un alojamiento con huéspedes por llegar,
// y entrega el acuerdo B2B vigente para calcular permitePaquete en el catálogo.
@Injectable()
export class ReservasVigentesService extends ConsultaReservasVigentes {
  constructor(
    @InjectRepository(Orden, CONEXION.reservas) private readonly ordenes: Repository<Orden>,
    @Optional() @InjectRepository(PromocionContrato, CONEXION.reservas) private readonly promociones?: Repository<PromocionContrato>,
  ) {
    super();
  }

  // Sin transacción de quien llama (8.4, E3): lee con su propia conexión
  async localizadores(filtro: { habitacionId: string } | { alojamientoId: number }): Promise<string[]> {
    const consulta = this.ordenes
      .createQueryBuilder('o')
      .select('o.locator', 'locator')
      .where('o.status IN (:...estados)', { estados: [OrdenStatus.CONFIRMED, OrdenStatus.CHECKED_IN] }) // el huésped alojado también cuenta
      .andWhere('o.checkout > :hoy', { hoy: hoyIso() })
      .orderBy('o.checkin', 'ASC');
    if ('habitacionId' in filtro) consulta.andWhere('o.habitacionId = :habitacionId', { habitacionId: filtro.habitacionId });
    else consulta.andWhere('o.alojamientoId = :alojamientoId', { alojamientoId: filtro.alojamientoId });
    const filas = await consulta.getRawMany<{ locator: string }>();
    return filas.map((f) => f.locator);
  }

  async acuerdoPromociones(): Promise<AcuerdoPromocionesVigentes | null> {
    if (!this.promociones) return null;
    const fila = await this.promociones.findOneBy({ id: 1 });
    return fila
      ? {
          permitePromociones: fila.permitePromociones,
          porcentajeMaximo: Number(fila.porcentajeMaximo),
          destinos: fila.destinos,
          vigenciaDesde: fila.vigenciaDesde,
          vigenciaHasta: fila.vigenciaHasta,
        }
      : null;
  }
}

// Global y sin depender del catálogo: así el catálogo recibe la respuesta sin importar el módulo de reservas
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Orden, PromocionContrato], CONEXION.reservas)],
  providers: [ReservasVigentesService, { provide: ConsultaReservasVigentes, useExisting: ReservasVigentesService }],
  exports: [ConsultaReservasVigentes],
})
export class ReservasPuertosModule {}

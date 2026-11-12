import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../common/common.module';
import { SeguridadUsuariosModule } from '../usuarios/usuarios.module';
import { AccesoReservasService } from './admin/acceso-reservas.service';
import { HabitacionesFisicasController } from './admin/habitaciones-fisicas.controller';
import { HabitacionesFisicasService } from './admin/habitaciones-fisicas.service';
import { RecepcionController } from './admin/recepcion.controller';
import { RecepcionService } from './admin/recepcion.service';
import { ReservasAdminController } from './admin/reservas-admin.controller';
import { ReservasPuertoController } from './admin/reservas-vigentes.http';
import { CuentaReservasController } from './cuenta-reservas.controller';
import { AuditoriaRecepcion } from './entities/auditoria-recepcion.entity';
import { HabitacionFisica } from './entities/habitacion-fisica.entity';
import { HistorialLimpieza } from './entities/historial-limpieza.entity';
import { IdempotenciaV2 } from './entities/idempotencia-v2.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OrdenPreview } from './entities/orden-preview.entity';
import { Orden } from './entities/orden.entity';
import { PromocionContrato } from './entities/promocion-contrato.entity';
import { Resena } from './entities/resena.entity';
import { SagaReserva } from './entities/saga-reserva.entity';
import { OrdenesV1Controller } from './ordenes-v1.controller';
import { OrdenesService } from './ordenes.service';
import { EstanciaV2Service } from './v2/estancia-v2.service';
import { PromocionesV2Controller, ResenasV2Controller } from './v2/estancia-v2.controller';
import { IdempotenciaV2Service } from './v2/idempotencia-v2';
import { LimpiezaReservasService } from './v2/limpieza-reservas.service';
import { OrdenesV2Controller } from './v2/ordenes-v2.controller';
import { OrdenesV2Service } from './v2/ordenes-v2.service';
import { PromocionesV2Service } from './v2/promociones-v2.service';
import { ResenasV2Service } from './v2/resenas-v2.service';
import { SagaReservaService } from './v2/saga-reserva.service';
import { BookingCheckinClient } from './v2/booking-checkin.client';
import { CONEXION } from '../../database/conexiones';

// Dominio reservas (fase 8.0 / 9.2): órdenes v1 y v2, idempotencia, estancia (check-in / check-out), reseñas y el acuerdo
// B2B de promociones. Solo registra su propio esquema en TypeORM; recibe CatalogoPuerto y DisponibilidadPuerto globalmente
// (locales en el monolito o HTTP en el proceso separado).
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Orden, OrdenPreview, IdempotencyKey, IdempotenciaV2, Resena, PromocionContrato, SagaReserva, AuditoriaRecepcion, HabitacionFisica, HistorialLimpieza],
      CONEXION.reservas,
    ),
    CommonModule,
    SeguridadUsuariosModule,
  ],
  // OrdenesV2Controller tiene /alojamientos/orders y /reservations: se registra antes que las rutas /alojamientos/{id}
  controllers: [
    OrdenesV1Controller,
    OrdenesV2Controller,
    PromocionesV2Controller,
    ResenasV2Controller,
    ReservasAdminController,
    CuentaReservasController,
    ReservasPuertoController,
    RecepcionController,
    HabitacionesFisicasController,
  ],
  providers: [
    OrdenesService,
    OrdenesV2Service,
    EstanciaV2Service,
    PromocionesV2Service,
    ResenasV2Service,
    IdempotenciaV2Service,
    AccesoReservasService,
    LimpiezaReservasService,
    SagaReservaService,
    BookingCheckinClient,
    RecepcionService,
    HabitacionesFisicasService,
  ],
  exports: [OrdenesService, PromocionesV2Service, LimpiezaReservasService, BookingCheckinClient],
})
export class ReservasModule {}

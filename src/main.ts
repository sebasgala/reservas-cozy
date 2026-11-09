import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { arrancarModulo, conexionUnicaModulo } from './bootstrap-modulo';
import { CommonModule } from './common/common.module';
import { crearControladorSaludModulo } from './health/salud-modulo';
import { CatalogoPuertosHttpModule } from './modules/catalogo/catalogo-puerto.http';
import { ComunDominioModule } from './modules/comun/comun.module';
import { DisponibilidadPuertosHttpModule } from './modules/disponibilidad/disponibilidad.puerto';
import { ReservasPuertosModule } from './modules/reservas/admin/reservas-vigentes';
import { ReservasModule } from './modules/reservas/reservas.module';

const SaludReservasController = crearControladorSaludModulo('reservas');

// Proceso separado del módulo reservas (fase 9.2): conecta solo como cozy_reservas y registra únicamente sus entidades.
// Consulta catálogo y disponibilidad mediante sus adaptadores HTTP (D1).
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    conexionUnicaModulo('reservas'),
    CommonModule,
    ComunDominioModule,
    CatalogoPuertosHttpModule,
    DisponibilidadPuertosHttpModule,
    ReservasPuertosModule,
    ReservasModule,
  ],
  controllers: [SaludReservasController],
})
export class ReservasAppModule {}

if (require.main === module) {
  void arrancarModulo({
    modulo: 'reservas',
    puertoPorDefecto: 3004,
    variablePuerto: 'PORT_RESERVAS',
    AppModulo: ReservasAppModule,
  });
}


import { Body, Controller, Get, Global, HttpCode, HttpStatus, Injectable, Module, Post, UseFilters } from '@nestjs/common';
import { AcuerdoPromocionesVigentes, ConsultaReservasVigentes } from '../../catalogo/reservas-vigentes.puerto';
import { llamarPuertoHttp, PuertoInternoFilter } from '../../comun/puerto-http';

@Controller('interno/reservas')
@UseFilters(PuertoInternoFilter)
export class ReservasPuertoController {
  constructor(private readonly reservas: ConsultaReservasVigentes) {}

  @Post('localizadores')
  @HttpCode(HttpStatus.OK)
  localizadores(@Body() cuerpo: { filtro: { habitacionId: string } | { alojamientoId: number } }): Promise<string[]> {
    return this.reservas.localizadores(cuerpo.filtro);
  }

  @Get('acuerdo-promociones')
  acuerdoPromociones(): Promise<AcuerdoPromocionesVigentes | null> {
    return this.reservas.acuerdoPromociones();
  }
}

// Implementación HTTP de ConsultaReservasVigentes para procesos fuera de reservas (D1 de fase 9.2).
@Injectable()
export class ReservasVigentesHttp extends ConsultaReservasVigentes {
  private get baseUrl(): string {
    return process.env.RESERVAS_URL?.trim() || 'http://localhost:3004';
  }

  localizadores(filtro: { habitacionId: string } | { alojamientoId: number }): Promise<string[]> {
    return llamarPuertoHttp<string[]>(this.baseUrl, '/api/v1/interno/reservas/localizadores', { cuerpo: { filtro } });
  }

  acuerdoPromociones(): Promise<AcuerdoPromocionesVigentes | null> {
    return llamarPuertoHttp<AcuerdoPromocionesVigentes | null>(this.baseUrl, '/api/v1/interno/reservas/acuerdo-promociones', { metodo: 'GET' });
  }
}

@Global()
@Module({
  providers: [ReservasVigentesHttp, { provide: ConsultaReservasVigentes, useExisting: ReservasVigentesHttp }],
  exports: [ConsultaReservasVigentes],
})
export class ReservasPuertosHttpModule {}


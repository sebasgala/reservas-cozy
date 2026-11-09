import { Body, Controller, Get, Param, Post, Put, Query, Req, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AutenticacionV2Guard, PrincipalV2 } from '../../usuarios/v2/autenticacion-v2';
import { idAlojamientoV2 } from '../../comun/v2/id-alojamiento-v2';
import { PaginaV2Query } from '../../catalogo/v2/dto/catalogo-v2.dto';
import { ContratoPromocionesV2Dto, CrearResenaV2Dto } from './dto/estancia-v2.dto';
import { EtagV2Interceptor } from '../../comun/v2/etag-v2.interceptor';
import { ProblemaV2Filter } from '../../comun/v2/problemas-v2';
import { PromocionesV2Service } from './promociones-v2.service';
import { auditarAccesoPii } from '../../comun/v2/registro-v2';
import { Reloj } from '../../comun/v2/reloj';
import { ahoraDe } from '../../comun/v2/reloj-prueba';
import { ResenasV2Service } from './resenas-v2.service';
import { OperacionV2 } from '../../usuarios/v2/seguridad-v2';
import { validacionConsultaV2, validacionCuerpoV2 } from '../../comun/v2/validacion-v2';

const principalDe = (req: Request): PrincipalV2 => (req as Request & { principalV2: PrincipalV2 }).principalV2;

// Acuerdo B2B de promociones. Ruta estática: se registra ANTES que AlojamientoV2Controller (`promociones` no es un id válido).
@ApiTags('Contrato v2 - Promociones B2B y Combos')
@Controller({ path: 'alojamientos/promociones', version: '2' })
@UseFilters(ProblemaV2Filter)
@UseGuards(AutenticacionV2Guard)
export class PromocionesV2Controller {
  constructor(
    private readonly promociones: PromocionesV2Service,
    private readonly reloj: Reloj,
  ) {}

  @Get('contrato')
  @ApiOperation({ operationId: 'getPromotionContract', summary: 'Consultar el acuerdo B2B vigente de promociones y combos' })
  @OperacionV2('getPromotionContract')
  obtener(@Req() req: Request) {
    auditarAccesoPii(req, 'getPromotionContract'); // lleva el contacto comercial (x-pii)
    return this.promociones.obtener();
  }

  @Put('contrato')
  @ApiOperation({ operationId: 'putPromotionContract', summary: 'Formalizar o actualizar el acuerdo B2B (solo ADMIN)' })
  @OperacionV2('putPromotionContract')
  formalizar(@Req() req: Request, @Body(validacionCuerpoV2()) cuerpo: ContratoPromocionesV2Dto) {
    return this.promociones.formalizar(cuerpo, principalDe(req), ahoraDe(this.reloj, req));
  }
}

// Reseñas: el listado es público; publicar exige el JWT de un CLIENTE con una reserva CHECKED_OUT suya.
@ApiTags('Contrato v2 - Reseñas y Calificaciones')
@Controller({ path: 'alojamientos', version: '2' })
@UseFilters(ProblemaV2Filter)
export class ResenasV2Controller {
  constructor(
    private readonly resenas: ResenasV2Service,
    private readonly reloj: Reloj,
  ) {}

  @Get(':id/resenas')
  @UseInterceptors(EtagV2Interceptor)
  @ApiOperation({ operationId: 'listResenas', summary: 'Reseñas de huéspedes con estancia verificada' })
  listar(@Param('id', idAlojamientoV2) id: string, @Query(validacionConsultaV2()) pagina: PaginaV2Query) {
    return this.resenas.listar(id, pagina);
  }

  @Get(':id/reviews')
  @UseInterceptors(EtagV2Interceptor)
  @ApiOperation({ operationId: 'listResenas_alojamientos_id_reviews', summary: 'Alias deprecado de {id}/resenas', deprecated: true })
  listarAlias(@Param('id', idAlojamientoV2) id: string, @Query(validacionConsultaV2()) pagina: PaginaV2Query) {
    return this.resenas.listar(id, pagina);
  }

  @Post(':id/resenas')
  @UseGuards(AutenticacionV2Guard)
  @ApiOperation({ operationId: 'createResena', summary: 'Publicar reseña (solo titular de una reserva CHECKED_OUT)' })
  @OperacionV2('createResena')
  crear(@Req() req: Request, @Param('id', idAlojamientoV2) id: string, @Body(validacionCuerpoV2()) cuerpo: CrearResenaV2Dto) {
    return this.resenas.crear(id, cuerpo, principalDe(req), ahoraDe(this.reloj, req));
  }

  @Post(':id/reviews')
  @UseGuards(AutenticacionV2Guard)
  @ApiOperation({ operationId: 'createResena_alojamientos_id_reviews', summary: 'Alias deprecado de {id}/resenas', deprecated: true })
  @OperacionV2('createResena_alojamientos_id_reviews')
  crearAlias(@Req() req: Request, @Param('id', idAlojamientoV2) id: string, @Body(validacionCuerpoV2()) cuerpo: CrearResenaV2Dto) {
    return this.resenas.crear(id, cuerpo, principalDe(req), ahoraDe(this.reloj, req));
  }
}

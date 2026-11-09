import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EstadoSaga } from '../entities/saga-reserva.entity';
import { correrSaga, DetalleSaga, PasoSaga } from './saga-reserva';

// Casos de fallo de la saga de reserva (fase 8.4, diseño §5) sobre el orquestador, con un inventario de cupos en memoria.
// Lo mismo, contra la base y los servicios reales, lo prueba scripts/probar-saga-reserva.mjs.
//
// Orden de una compra (OrdenesV2Service.crear): pasos del orquestador (retener, orden PENDING, confirmar la retención SIN
// aviso de stock) → transacción de la reserva (orden CONFIRMED y evento) → aviso de stock a Booking, solo si esa transacción
// se confirmó. El barrido (SagaReservaService.cerrar) termina hacia adelante lo que quedó a medias.

class Escenario {
  cupos = 2;
  retenida = 0;
  confirmada = false;
  orden: 'NINGUNA' | 'PENDING' | 'CONFIRMED' | 'CANCELLED' = 'NINGUNA';
  avisosStock = 0;
  avisada = false;
  readonly anotados: { estado: EstadoSaga; detalle?: DetalleSaga }[] = [];
  readonly llamadas: string[] = [];
  fallarEn: string | null = null;
  fallarCompensacion = false;

  private falla(paso: string) {
    if (this.fallarEn === paso) throw new Error(`fallo inyectado en ${paso}`);
  }

  pasos(cantidad = 1): PasoSaga[] {
    return [
      {
        estado: 'CUPOS_RETENIDOS',
        hacer: async () => {
          this.llamadas.push('retener');
          this.falla('retener');
          if (this.retenida === 0) {
            if (this.cupos < cantidad) throw new Error('OUT_OF_STOCK');
            this.cupos -= cantidad;
            this.retenida = cantidad;
          }
        },
        compensar: async () => {
          this.llamadas.push('liberar');
          if (this.fallarCompensacion) throw new Error('disponibilidad no responde');
          this.cupos += this.retenida; // idempotente: liberar dos veces no devuelve dos veces
          this.retenida = 0;
        },
      },
      {
        estado: 'ORDEN_CREADA',
        hacer: async () => {
          this.llamadas.push('crearOrden');
          this.falla('crearOrden');
          if (this.orden === 'NINGUNA') this.orden = 'PENDING';
        },
        compensar: async () => {
          this.llamadas.push('compensarOrden');
          if (this.orden === 'PENDING') this.orden = 'CANCELLED';
        },
      },
      {
        estado: 'RETENCION_CONFIRMADA',
        hacer: async () => {
          this.llamadas.push('confirmar');
          this.falla('confirmar');
          this.confirmada = true; // confirmarRetencion(ordenId, null, []): definitiva, sin aviso de stock
          this.falla('trasConfirmar');
        },
        comprobar: async () => this.confirmada,
      },
    ];
  }

  // Paso 4b: la transacción de la reserva (orden CONFIRMED y evento)
  transaccionReserva() {
    this.llamadas.push('transaccionReserva');
    this.falla('transaccionReserva');
    if (this.orden === 'PENDING') this.orden = 'CONFIRMED';
  }

  // Paso 5: SagaReservaService.avisarReserva. Solo con la orden ya confirmada; no lanza (si falla, lo reintenta el barrido)
  avisarStock() {
    if (this.avisada || this.orden !== 'CONFIRMED') return;
    this.llamadas.push('avisarStock');
    try {
      this.falla('avisarStock');
    } catch {
      return;
    }
    this.avisosStock++;
    this.avisada = true;
    this.anotados.push({ estado: 'CONFIRMADA' });
  }

  // SagaReservaService.cerrar para una saga con la retención confirmada: termina hacia adelante
  barrido() {
    if (this.orden === 'PENDING') this.transaccionReserva();
    this.avisarStock();
  }

  anotar = async (estado: EstadoSaga, detalle?: DetalleSaga) => {
    this.anotados.push({ estado, detalle });
  };

  get estado(): EstadoSaga {
    return this.anotados.at(-1)?.estado ?? 'INICIADA';
  }
}

// Una compra entera, en el orden de OrdenesV2Service.crear
async function comprar(e: Escenario, estadoPrevio: EstadoSaga = 'INICIADA', cantidad = 1) {
  // Una saga ya CONFIRMADA no vuelve atrás al repetir sus pasos (igual que OrdenesV2Service.prepararCompra)
  await correrSaga(e.pasos(cantidad), estadoPrevio, estadoPrevio === 'CONFIRMADA' ? async () => undefined : e.anotar);
  e.transaccionReserva();
  e.avisarStock();
}

test('camino feliz: los pasos en orden, la reserva confirmada y el aviso de stock solo al final', async () => {
  const e = new Escenario();
  await comprar(e);
  assert.deepEqual(e.anotados.map((a) => a.estado), ['CUPOS_RETENIDOS', 'ORDEN_CREADA', 'RETENCION_CONFIRMADA', 'CONFIRMADA']);
  assert.deepEqual(e.llamadas, ['retener', 'crearOrden', 'confirmar', 'transaccionReserva', 'avisarStock'], 'el aviso va después de la transacción de la reserva');
  assert.equal(e.cupos, 1);
  assert.equal(e.orden, 'CONFIRMED');
  assert.equal(e.avisosStock, 1);
});

test('confirmar la retención no avisa stock: el aviso espera a que la reserva se confirme', async () => {
  const e = new Escenario();
  await correrSaga(e.pasos(), 'INICIADA', e.anotar);
  assert.equal(e.confirmada, true);
  assert.equal(e.avisosStock, 0, 'con la retención confirmada pero la reserva sin confirmar, Booking no sabe nada');
  assert.equal(e.orden, 'PENDING');
});

test('compensación completa: falla la confirmación después de retener y crear la orden', async () => {
  const e = new Escenario();
  e.fallarEn = 'confirmar';
  await assert.rejects(comprar(e), /fallo inyectado en confirmar/); // se lanza el error original
  assert.deepEqual(e.llamadas, ['retener', 'crearOrden', 'confirmar', 'compensarOrden', 'liberar'], 'compensa en orden inverso');
  assert.equal(e.cupos, 2, 'los cupos vuelven a su valor anterior');
  assert.equal(e.retenida, 0);
  assert.equal(e.orden, 'CANCELLED', 'la orden PENDING queda CANCELLED (COMPENSATED en la base)');
  assert.equal(e.avisosStock, 0, 'Booking nunca recibió aviso');
  assert.equal(e.estado, 'COMPENSADA');
  assert.equal(e.anotados.at(-1)?.detalle?.pasoFallido, 'RETENCION_CONFIRMADA');
  assert.match(e.anotados.at(-1)?.detalle?.error ?? '', /fallo inyectado en confirmar/);
});

test('falla la transacción de la reserva después de confirmar la retención: no queda ningún aviso de stock', async () => {
  const e = new Escenario();
  e.fallarEn = 'transaccionReserva';
  await assert.rejects(comprar(e), /fallo inyectado en transaccionReserva/);
  assert.equal(e.confirmada, true, 'la retención ya era definitiva');
  assert.equal(e.orden, 'PENDING', 'la reserva no llegó a confirmarse');
  assert.equal(e.avisosStock, 0, 'y por eso Booking no recibió ningún aviso');
  assert.ok(!e.llamadas.includes('avisarStock'), 'ni siquiera se intentó avisar');
  assert.ok(!e.llamadas.includes('liberar') && !e.llamadas.includes('compensarOrden'), 'desde la retención confirmada no se compensa');
  // El barrido (o el reintento con la misma clave) la termina hacia adelante: reserva confirmada y UN solo aviso
  e.fallarEn = null;
  e.barrido();
  assert.equal(e.orden, 'CONFIRMED');
  assert.equal(e.avisosStock, 1, 'el aviso sale una sola vez, ya con la reserva confirmada');
  assert.equal(e.estado, 'CONFIRMADA');
  e.barrido();
  assert.equal(e.avisosStock, 1, 'repetir el barrido no avisa otra vez');
});

test('falla el aviso de stock con la reserva ya confirmada: la reserva se queda y el barrido avisa', async () => {
  const e = new Escenario();
  e.fallarEn = 'avisarStock';
  await comprar(e); // no lanza: la orden está confirmada y se responde 201
  assert.equal(e.orden, 'CONFIRMED');
  assert.equal(e.avisosStock, 0);
  assert.equal(e.estado, 'RETENCION_CONFIRMADA', 'la saga no se da por terminada hasta avisar');
  assert.ok(!e.llamadas.includes('liberar') && !e.llamadas.includes('compensarOrden'), 'no se compensa una reserva confirmada');
  e.fallarEn = null;
  e.barrido();
  assert.equal(e.avisosStock, 1);
  assert.equal(e.estado, 'CONFIRMADA');
});

test('disponibilidad no bloquea: sin cupo no se crea orden ni hay nada que compensar', async () => {
  const e = new Escenario();
  await assert.rejects(comprar(e, 'INICIADA', 5), /OUT_OF_STOCK/);
  assert.deepEqual(e.llamadas, ['retener']);
  assert.equal(e.orden, 'NINGUNA');
  assert.equal(e.cupos, 2);
  assert.deepEqual(e.anotados.map((a) => a.estado), ['COMPENSANDO', 'COMPENSADA']);
  assert.equal(e.anotados.at(-1)?.detalle?.pasoFallido, 'CUPOS_RETENIDOS');
});

test('falla al crear la orden (por ejemplo, el precio no cuadra): se devuelven los cupos', async () => {
  const e = new Escenario();
  e.fallarEn = 'crearOrden';
  await assert.rejects(comprar(e), /fallo inyectado en crearOrden/);
  assert.deepEqual(e.llamadas, ['retener', 'crearOrden', 'liberar']);
  assert.equal(e.cupos, 2);
  assert.equal(e.orden, 'NINGUNA');
  assert.equal(e.estado, 'COMPENSADA');
});

test('confirmación que llega a la base pero responde con error: se comprueba y la saga sigue, sin compensar', async () => {
  const e = new Escenario();
  e.fallarEn = 'trasConfirmar';
  await correrSaga(e.pasos(), 'INICIADA', e.anotar);
  assert.ok(!e.llamadas.includes('liberar') && !e.llamadas.includes('compensarOrden'), 'no compensa nada');
  assert.equal(e.avisosStock, 0, 'el aviso espera a la transacción de la reserva');
  assert.equal(e.estado, 'RETENCION_CONFIRMADA');
  // Retomada (reintento con la misma Idempotency-Key): vuelve a correr los pasos, idempotentes
  e.fallarEn = null;
  e.anotados.push({ estado: 'RETENCION_CONFIRMADA' });
  await comprar(e, 'RETENCION_CONFIRMADA');
  assert.equal(e.cupos, 1, 'no retiene dos veces');
  assert.equal(e.avisosStock, 1, 'avisa una sola vez');
  assert.equal(e.orden, 'CONFIRMED');
});

test('saga retomada tras el punto sin retorno: si un paso falla, el error sube y no se compensa', async () => {
  const e = new Escenario();
  await correrSaga(e.pasos(), 'INICIADA', e.anotar);
  e.fallarEn = 'crearOrden';
  // La retención ya estaba confirmada: aunque el reintento falle, no se deshace
  await assert.rejects(correrSaga(e.pasos(), 'RETENCION_CONFIRMADA', e.anotar), /fallo inyectado en crearOrden/);
  assert.ok(!e.llamadas.includes('liberar') && !e.llamadas.includes('compensarOrden'));
  assert.equal(e.cupos, 1);
  assert.equal(e.avisosStock, 0);
});

test('reintento duplicado: la misma saga corrida dos veces deja un solo descuento y un solo aviso', async () => {
  const e = new Escenario();
  await comprar(e);
  await comprar(e, e.estado);
  assert.equal(e.cupos, 1);
  assert.equal(e.avisosStock, 1);
  assert.equal(e.orden, 'CONFIRMED');
  assert.equal(e.estado, 'CONFIRMADA', 'repetir los pasos no devuelve la saga a un estado anterior');
});

test('compensación idempotente: compensar dos veces no devuelve los cupos dos veces', async () => {
  const e = new Escenario();
  e.fallarEn = 'confirmar';
  await assert.rejects(comprar(e));
  const [liberar, compensarOrden] = [e.pasos()[0].compensar!, e.pasos()[1].compensar!];
  await compensarOrden();
  await liberar();
  assert.equal(e.cupos, 2);
  assert.equal(e.orden, 'CANCELLED');
});

test('si la compensación falla, la saga queda COMPENSANDO para el barrido y sube el error original', async () => {
  const e = new Escenario();
  e.fallarEn = 'confirmar';
  e.fallarCompensacion = true;
  await assert.rejects(comprar(e), /fallo inyectado en confirmar/);
  assert.equal(e.estado, 'COMPENSANDO');
  assert.match(e.anotados.at(-1)?.detalle?.error ?? '', /compensación incompleta: Error: disponibilidad no responde/);
  assert.equal(e.retenida, 1, 'los cupos siguen retenidos hasta que el barrido termine');
});

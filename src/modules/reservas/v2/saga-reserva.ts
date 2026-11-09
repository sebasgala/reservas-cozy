import { EstadoSaga } from '../entities/saga-reserva.entity';

// Orquestador de la saga de reserva (fase 8.4, decisión 1): reservas dirige los pasos en el mismo proceso y cada paso
// corre en la transacción de su dominio. Esta parte no toca la base: recibe los pasos y cómo anotar el estado, así se
// prueba sola (saga-reserva.spec.ts).
//
// Reglas:
//   - Los pasos corren en orden y TODOS son idempotentes: al retomar una saga se vuelven a correr desde el primero
//     (reservar repetido devuelve lo mismo, la orden ya creada no se crea otra vez, confirmar repetido no avisa dos veces).
//   - Al terminar cada paso se anota el estado al que llega la saga.
//   - Si un paso falla y declara `comprobar`, se comprueba (de forma idempotente) si su efecto quedó hecho igual: una
//     confirmación que llegó a la base pero respondió con error no se compensa, la saga sigue.
//   - Si un paso falla antes del punto sin retorno, se compensan en orden inverso los pasos que sí terminaron y la saga
//     queda COMPENSADA; luego se vuelve a lanzar el error original (el que recibe quien llamó).
//   - Si falla una compensación, la saga queda COMPENSANDO (el barrido la reintenta) y se lanza el error original.
//   - Desde el punto sin retorno (RETENCION_CONFIRMADA: la retención ya es definitiva) no se compensa: el error se lanza
//     tal cual y la saga se termina hacia adelante en el reintento o en el barrido. El aviso de stock a Booking NO es un paso
//     de esta lista: sale después de que la orden se confirma (SagaReservaService.avisarReserva), así que hasta ahí no hay
//     nada que Booking haya recibido ni que devolver.

export interface PasoSaga {
  // Estado al que llega la saga cuando el paso termina
  estado: EstadoSaga;
  hacer: () => Promise<void>;
  // Deshace el paso si uno posterior falla (sin compensación: el paso no deja nada que deshacer)
  compensar?: () => Promise<void>;
  // Tras un fallo del paso: ¿su efecto quedó hecho? (idempotente; si lo está, la saga sigue sin compensar)
  comprobar?: () => Promise<boolean>;
}

export interface DetalleSaga {
  pasoFallido?: string;
  error?: string;
}

export type AnotarSaga = (estado: EstadoSaga, detalle?: DetalleSaga) => Promise<void>;

export const SIN_RETORNO: readonly EstadoSaga[] = ['RETENCION_CONFIRMADA', 'CONFIRMADA'];

export async function correrSaga(pasos: PasoSaga[], estadoPrevio: EstadoSaga, anotar: AnotarSaga): Promise<void> {
  let sinRetorno = SIN_RETORNO.includes(estadoPrevio);
  const hechos: PasoSaga[] = [];
  for (const paso of pasos) {
    try {
      await paso.hacer();
    } catch (error) {
      const hecho = paso.comprobar ? await paso.comprobar().catch(() => false) : false;
      if (!hecho) {
        if (sinRetorno) throw error;
        await compensar(hechos, paso.estado, error, anotar);
        throw error;
      }
    }
    hechos.push(paso);
    await anotar(paso.estado);
    if (SIN_RETORNO.includes(paso.estado)) sinRetorno = true;
  }
}

// Compensa en orden inverso. El paso que falló se nombra por el estado al que iba a llegar.
export async function compensar(hechos: PasoSaga[], pasoFallido: string, error: unknown, anotar: AnotarSaga): Promise<void> {
  const detalle: DetalleSaga = { pasoFallido, error: mensajeDe(error) };
  await anotar('COMPENSANDO', detalle);
  try {
    for (const paso of [...hechos].reverse()) if (paso.compensar) await paso.compensar();
  } catch (fallo) {
    // Queda COMPENSANDO: el barrido vuelve a intentarlo. Se anota por qué no terminó.
    await anotar('COMPENSANDO', { pasoFallido, error: `compensación incompleta: ${mensajeDe(fallo)}` }).catch(() => undefined);
    return;
  }
  await anotar('COMPENSADA', detalle);
}

export function mensajeDe(error: unknown): string {
  const texto = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return texto.slice(0, 500);
}

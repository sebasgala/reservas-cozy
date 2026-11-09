# Microservicio de Reservas (`reservas-cozy`)

Microservicio de gestión de órdenes de compra, ciclo de vida de estancias, reservas de clientes, saga transaccional, promociones y reseñas de Cozy.

## Características
- **Órdenes y Reservas:** Creación idempotente, confirmación, cancelación, check-in y check-out.
- **Saga de Reserva:** Coordinación de retención, cobro simulado y confirmación con disponibilidad.
- **Contrato de Puerto:** Expone `reservas-vigentes` vía REST interno para catálogo (validación antes de bajas).
- **Consumo de Dependencias:** Llama a `disponibilidad` y `catalogo` vía adaptadores HTTP internos.
- **Base de datos:** Conexión exclusiva con rol `cozy_reservas` sobre el esquema `reservas` de `cozy_v2`.
- **Salud:** `GET /health` en el puerto 3004.

## Instalación y compilación
```bash
npm ci
npm run build
```

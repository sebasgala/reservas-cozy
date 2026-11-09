import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { ColumnNumericTransformer } from '../../../common/transformers/column-numeric.transformer';
import { OrdenPreview } from './orden-preview.entity';

// Mismos valores que el enum status de OrderDetail en el contrato.
export enum OrdenStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  // Solo las pone la v2 (check-in y check-out digitales)
  CHECKED_IN = 'CHECKED_IN',
  CHECKED_OUT = 'CHECKED_OUT',
}

// Nombres de restricciones que el código necesita reconocer cuando PostgreSQL las reporta.
export const UQ_ORDENES_LOCATOR = 'UQ_e3a1516e13b1a7c08532fc5b167';
export const UQ_ORDENES_PREVIEW = 'UQ_ordenes_previewId';

// Su id es el order_id del contrato.
@Entity({ name: 'ordenes', schema: 'reservas' })
@Check('CHK_ordenes_total', '"totalPrice" >= 0')
@Check('CHK_ordenes_fechas', '"checkout" > "checkin"')
@Check('CHK_ordenes_habitaciones_reservadas', '"habitacionesReservadas" >= 1')
@Check('CHK_ordenes_reembolso', '("porcentajeReembolso" IS NULL OR "porcentajeReembolso" BETWEEN 0 AND 100) AND ("montoReembolsado" IS NULL OR "montoReembolsado" >= 0)')
@Check(
  'CHK_ordenes_estancia',
  `("status"::text NOT IN ('CHECKED_IN', 'CHECKED_OUT') OR "checkInEn" IS NOT NULL) AND ("status"::text <> 'CHECKED_OUT' OR "checkOutEn" IS NOT NULL) AND ("consumosAdicionales" IS NULL OR "consumosAdicionales" >= 0)`,
)
@Unique('UQ_ordenes_codigoReembolso', ['codigoReembolso'])
export class Orden {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Código de confirmación visible para el cliente (equivale al PNR)
  @Column({ type: 'varchar', length: 50, unique: true })
  locator: string;

  @Column({ type: 'enum', enum: OrdenStatus, default: OrdenStatus.PENDING })
  status: OrdenStatus;

  // Referencias lógicas al catálogo (fase 8): sin relación de TypeORM; lo que la orden muestra va copiado abajo
  @Index('IX_ordenes_alojamientoId')
  @Column({ type: 'int' })
  alojamientoId: number;

  @Index('IX_ordenes_habitacionId')
  @Column({ type: 'uuid' })
  habitacionId: string;

  // Copia del catálogo al reservar (fase 8.0): así reservas muestra la orden sin leer alojamientos ni habitaciones
  @Column({ type: 'varchar', length: 64 })
  alojamientoCodigo: string;

  @Column({ type: 'varchar', length: 255 })
  alojamientoNombre: string;

  @Column({ type: 'varchar', length: 40 })
  habitacionCodigo: string;

  @Column({ type: 'varchar', length: 255 })
  habitacionNombre: string;

  // Política y régimen de la habitación, para las órdenes v1 que no guardaron su plan
  @Column({ type: 'varchar', length: 100, nullable: true })
  habitacionCancellationType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  habitacionMealPlan: string | null;

  // Vista previa de la que salió la orden. Índice único: un preview da una sola orden.
  // Null en órdenes anteriores a esta columna o si el preview se borra (ON DELETE SET NULL).
  @Index(UQ_ORDENES_PREVIEW, { unique: true })
  @Column({ type: 'uuid', nullable: true })
  previewId: string | null;

  @ManyToOne(() => OrdenPreview, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'previewId', foreignKeyConstraintName: 'FK_ordenes_previewId' })
  preview: OrdenPreview | null;

  @Column({ type: 'jsonb' })
  guests: Record<string, any>;

  @Column({ type: 'date' })
  checkin: string;

  @Column({ type: 'date' })
  checkout: string;

  // Cupos que se descontaron de cada noche (= guests.number_of_rooms). La cancelación devuelve
  // exactamente este número, sin depender del JSON de huéspedes.
  @Column({ type: 'int' })
  habitacionesReservadas: number;

  @Column({ type: 'varchar', length: 120 })
  customerFirstName: string;

  @Column({ type: 'varchar', length: 120 })
  customerLastName: string;

  @Column({ type: 'varchar', length: 255 })
  customerEmail: string;

  @Column('numeric', {
    precision: 10,
    scale: 2,
    transformer: new ColumnNumericTransformer(),
  })
  totalPrice: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 255 })
  paymentReference: string;

  // Cliente con cuenta que hizo la compra. Null = compra sin cuenta (o anterior a las cuentas).
  @Index('IX_ordenes_clienteId')
  @Column({ type: 'uuid', nullable: true })
  clienteId: string | null;

  @Index('IX_ordenes_createdAt')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // ───────────── Contrato v2 (fase 4). Todo opcional: las órdenes de la v1 no lo llevan. ─────────────

  // saga_id de la Saga del ESB: permite recuperar la orden tras un timeout (GET /orders?saga_id=)
  @Index('IX_ordenes_sagaId')
  @Column({ type: 'varchar', length: 64, nullable: true })
  sagaId: string | null;

  // Idempotency-Key con la que se creó (GET /orders?idempotency_key=)
  @Index('IX_ordenes_claveIdempotencia')
  @Column({ type: 'uuid', nullable: true })
  claveIdempotencia: string | null;

  @Index('IX_ordenes_cotizacionId')
  @Column({ type: 'uuid', nullable: true })
  cotizacionId: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  planTarifaCodigo: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  regimen: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  modeloPago: string | null;

  // payment_method del contrato (TARJETA_CREDITO, SIMULADO…)
  @Column({ type: 'varchar', length: 30, nullable: true })
  metodoPago: string | null;

  // Datos personales (x-pii): no van a logs ni a eventos
  @Column({ type: 'jsonb', nullable: true })
  huespedTitular: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  huespedesAdicionales: Record<string, any>[] | null;

  @Column({ type: 'text', nullable: true })
  peticionesEspeciales: string | null;

  // DesgloseFiscalV2 tal como se devolvió al crear
  @Column({ type: 'jsonb', nullable: true })
  desgloseFiscal: Record<string, any> | null;

  // Política del plan vendido (no cambia aunque luego se edite el plan)
  @Column({ type: 'jsonb', nullable: true })
  politicaCancelacion: Record<string, any> | null;

  // Cancelación: se fija la primera vez y un reintento devuelve lo mismo
  @Column({ type: 'varchar', length: 20, nullable: true })
  codigoReembolso: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  refundStatus: string | null;

  @Column('numeric', { precision: 5, scale: 2, nullable: true, transformer: new ColumnNumericTransformer() })
  porcentajeReembolso: number | null;

  @Column('numeric', { precision: 10, scale: 2, nullable: true, transformer: new ColumnNumericTransformer() })
  montoReembolsado: number | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  solicitadoPor: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  motivoCancelacion: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  canceladaEn: Date | null;

  // ───────────── Contrato v2 (fase 7): estancia ─────────────

  // Lo fija solo un administrador (PUT early-checkin). `earlyCheckinDesde` es el instante desde el cual se permite el check-in.
  @Column({ type: 'boolean', default: false })
  earlyCheckinAutorizado: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  earlyCheckinDesde: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  earlyCheckinMotivo: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkInEn: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  habitacionAsignada: string | null;

  // Credencial secreta (x-secret): nunca a logs ni eventos. Se borra en el check-out.
  @Column({ type: 'varchar', length: 40, nullable: true })
  claveAccesoDigital: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkOutEn: Date | null;

  @Column('numeric', { precision: 10, scale: 2, nullable: true, transformer: new ColumnNumericTransformer() })
  consumosAdicionales: number | null;

  @Column({ type: 'jsonb', nullable: true })
  consumos: Record<string, any>[] | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  metodoPagoConsumos: string | null;

  // Paquete (combo) con el que se vendió: { paqueteId, descuentoPorcentaje, descuentoMonto }
  @Column({ type: 'jsonb', nullable: true })
  paquete: Record<string, any> | null;
}

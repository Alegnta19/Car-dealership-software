/**
 * The standard bilingual multi-point inspection checklist.
 *
 * The item content (keys, categories, English/Spanish titles, photo requirements,
 * severity rubrics) comes from the origin platform's phase-229 seed — the one piece of
 * that module worth carrying (docs/PLATFORM-CONTEXT.md records the rest was refused).
 * Reshaped for this repo: rubric keys use the MPI result vocabulary the API actually
 * accepts (`pass` / `attention` / `fail`, see `recordMPIResult`) instead of the origin's
 * ok/attention/urgent, and every item carries an explicit `default_severity` from the
 * repo's severity set (`info` / `maintenance` / `safety`) — the same values
 * `submitMPISession` maps to recommendation priorities (safety→p0, maintenance→p1).
 *
 * This is data, not schema: `mpi_templates.items` is free JSONB and the API records
 * results by `item_key` alone. The shape here is the documented convention for clients
 * rendering a checklist.
 */

export interface StandardMPIItem {
  item_key: string;
  category: string;
  title_i18n: { en: string; es: string };
  default_severity: 'info' | 'maintenance' | 'safety';
  photo_required?: boolean;
  severity_rubric?: { pass: string; attention: string; fail: string };
}

const TIRE_RUBRIC = { pass: '≥5/32', attention: '3-4/32', fail: '≤2/32' } as const;

export const STANDARD_MPI_TEMPLATE_NAME = 'Standard Multi-Point Inspection';

export const STANDARD_MPI_ITEMS: readonly StandardMPIItem[] = [
  {
    item_key: 'tire_tread_lf',
    category: 'Tires & Wheels',
    default_severity: 'safety',
    title_i18n: { en: 'Left Front Tire Tread', es: 'Banda de Rodamiento Delantera Izquierda' },
    severity_rubric: TIRE_RUBRIC,
  },
  {
    item_key: 'tire_tread_rf',
    category: 'Tires & Wheels',
    default_severity: 'safety',
    title_i18n: { en: 'Right Front Tire Tread', es: 'Banda de Rodamiento Delantera Derecha' },
    severity_rubric: TIRE_RUBRIC,
  },
  {
    item_key: 'tire_tread_lr',
    category: 'Tires & Wheels',
    default_severity: 'safety',
    title_i18n: { en: 'Left Rear Tire Tread', es: 'Banda de Rodamiento Trasera Izquierda' },
    severity_rubric: TIRE_RUBRIC,
  },
  {
    item_key: 'tire_tread_rr',
    category: 'Tires & Wheels',
    default_severity: 'safety',
    title_i18n: { en: 'Right Rear Tire Tread', es: 'Banda de Rodamiento Trasera Derecha' },
    severity_rubric: TIRE_RUBRIC,
  },
  {
    item_key: 'brake_pads_front',
    category: 'Brakes',
    default_severity: 'safety',
    photo_required: true,
    title_i18n: { en: 'Front Brake Pads', es: 'Pastillas de Freno Delanteras' },
  },
  {
    item_key: 'brake_pads_rear',
    category: 'Brakes',
    default_severity: 'safety',
    photo_required: true,
    title_i18n: { en: 'Rear Brake Pads', es: 'Pastillas de Freno Traseras' },
  },
  {
    item_key: 'brake_rotors',
    category: 'Brakes',
    default_severity: 'safety',
    title_i18n: { en: 'Brake Rotors', es: 'Discos de Freno' },
  },
  {
    item_key: 'engine_oil',
    category: 'Fluids',
    default_severity: 'maintenance',
    title_i18n: { en: 'Engine Oil Level & Condition', es: 'Nivel y Condición del Aceite de Motor' },
  },
  {
    item_key: 'coolant',
    category: 'Fluids',
    default_severity: 'maintenance',
    title_i18n: { en: 'Coolant Level', es: 'Nivel de Refrigerante' },
  },
  {
    item_key: 'transmission_fluid',
    category: 'Fluids',
    default_severity: 'maintenance',
    title_i18n: { en: 'Transmission Fluid', es: 'Fluido de Transmisión' },
  },
  {
    item_key: 'battery_test',
    category: 'Electrical',
    default_severity: 'maintenance',
    photo_required: true,
    title_i18n: { en: 'Battery Test', es: 'Prueba de Batería' },
  },
  {
    item_key: 'headlights',
    category: 'Electrical',
    default_severity: 'safety',
    title_i18n: { en: 'Headlights', es: 'Luces Delanteras' },
  },
  {
    item_key: 'wipers',
    category: 'Exterior',
    default_severity: 'maintenance',
    title_i18n: { en: 'Wiper Blades', es: 'Limpiaparabrisas' },
  },
  {
    item_key: 'air_filter',
    category: 'Engine',
    default_severity: 'maintenance',
    photo_required: true,
    title_i18n: { en: 'Air Filter', es: 'Filtro de Aire' },
  },
  {
    item_key: 'cabin_filter',
    category: 'HVAC',
    default_severity: 'info',
    title_i18n: { en: 'Cabin Air Filter', es: 'Filtro de Aire de Cabina' },
  },
  {
    item_key: 'serpentine_belt',
    category: 'Engine',
    default_severity: 'maintenance',
    title_i18n: { en: 'Serpentine Belt', es: 'Correa Serpentina' },
  },
  {
    item_key: 'exhaust_system',
    category: 'Undercarriage',
    default_severity: 'maintenance',
    title_i18n: { en: 'Exhaust System', es: 'Sistema de Escape' },
  },
  {
    item_key: 'suspension',
    category: 'Undercarriage',
    default_severity: 'safety',
    title_i18n: { en: 'Suspension Components', es: 'Componentes de Suspensión' },
  },
];

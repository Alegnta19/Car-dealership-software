/** Placeholder shell — populated by FBL-020 slice 4. */
export const ORGANIZATION_LEVELS = [
  'tenant',
  'dealer_group',
  'legal_entity',
  'rooftop',
  'department',
] as const;
export type OrganizationLevel = (typeof ORGANIZATION_LEVELS)[number];

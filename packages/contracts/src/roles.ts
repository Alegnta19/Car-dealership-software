/**
 * @dealer/contracts — the role vocabulary and authenticated-context contract shared by
 * transport (apps/api), business logic (@dealer/fixed-ops) and tests. Framework-neutral.
 */
/**
 * Roles recognised by the service platform. A principal may hold several.
 * `platform_admin` is implicitly allowed everywhere (see `authorize`).
 */
export const ROLES = {
  ADMIN: 'platform_admin',
  SERVICE_MANAGER: 'service_manager',
  SERVICE_ADVISOR: 'service_advisor',
  TECHNICIAN: 'service_technician',
  PARTS_CLERK: 'parts_clerk',
  WARRANTY_ADMIN: 'warranty_admin',
  VIEWER: 'service_viewer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Every role that may look at service data at all. */
export const READ_ROLES: Role[] = [
  ROLES.SERVICE_MANAGER,
  ROLES.SERVICE_ADVISOR,
  ROLES.TECHNICIAN,
  ROLES.PARTS_CLERK,
  ROLES.WARRANTY_ADMIN,
  ROLES.VIEWER,
];

export interface TenantContext {
  tenantId: string;
  userId: string;
  roles: Role[];
}

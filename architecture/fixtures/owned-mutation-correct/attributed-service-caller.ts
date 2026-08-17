/**
 * POSITIVE FIXTURE (FBL-020-R4 §5) — deliberately RIGHT.
 *
 * Production code that changes authorization state through the attributed service:
 * an explicit acting user link, and the service advances the version and writes the
 * audit row. The guard must ACCEPT it — a guard that rejected this would be refusing
 * the sanctioned path and would be switched off within a week.
 */
import { changeOrganizationUnitStatus } from '@dealer/identity-access';

export async function retireRooftop(input: {
  actingUserLinkId: string;
  tenantId: string;
  rooftopId: string;
}): Promise<void> {
  await changeOrganizationUnitStatus({
    actingUserLinkId: input.actingUserLinkId,
    tenantId: input.tenantId,
    level: 'rooftop',
    unitId: input.rooftopId,
    status: 'archived',
  });
}

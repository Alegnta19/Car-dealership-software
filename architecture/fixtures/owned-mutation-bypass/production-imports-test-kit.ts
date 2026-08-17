/**
 * NEGATIVE FIXTURE (FBL-020-R4 §5) — deliberately WRONG.
 *
 * Production code reaching for the fixture-only write primitive. The primitive's
 * unreachability from production is one of §5's claims, so the guard proves it rather
 * than trusting the dependency manifest: `test-kit-must-not-be-imported-by-production`.
 */
import { fixtureAuthorizationStateWrite } from '@dealer/test-kit';

export async function sneak(userLinkId: string): Promise<void> {
  await fixtureAuthorizationStateWrite(
    'seed-authorization-state',
    'UPDATE user_links SET status = $2 WHERE user_link_id = $1',
    [userLinkId, 'activated'],
  );
}

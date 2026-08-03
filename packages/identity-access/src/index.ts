/**
 * @dealer/identity-access — managed identity, sessions, policy, reauthentication
 * and support access (FBL-020).
 *
 * The WorkOS SDK lives ONLY inside ./provider/workos/ (architecture-enforced);
 * every export here is provider-neutral. WorkOS role/permission claims are
 * display hints — authorization is decided from database-authoritative
 * RoleBindings by the policy engine, never from token content.
 */
export * from './contracts';
export * from './oidc/token-verifier';
export { createWorkosProvider, type WorkosAdapterOptions } from './provider/workos/adapter';
export * from './user-link';
export * from './session';
export * from './policy';
export * from './actions';
export * from './reauthentication';
export * from './support-access';
export * from './actor';
export * from './sealed-cookie';
export * from './federation';

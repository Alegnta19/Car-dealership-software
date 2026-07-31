/**
 * @dealer/organization — the canonical internal organization hierarchy (FBL-020).
 *
 * Owns Tenant -> DealerGroup -> LegalEntity -> Rooftop -> Department, hierarchy
 * validation, effective-status resolution, and the organization repositories. The
 * internal Tenant record is the authoritative business/data-ownership boundary; the
 * WorkOS Organization is only the external authentication mapping, owned by
 * @dealer/identity-access.
 */
export * from './model';
export * from './repository';

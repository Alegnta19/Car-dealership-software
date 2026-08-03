/**
 * Enterprise federation INTERFACES ONLY (FBL-020).
 *
 * SAML SSO and SCIM directory sync are named here so the shapes exist, are
 * type-checked, and are architecture-tested — and NOTHING more. There is no
 * implementation, no route, no configuration key and no database column that
 * can turn either on: enabling them is a future order with its own review.
 * Migration 055's provider CHECK admits only 'workos', so even a hand-written
 * INSERT cannot create a SAML or SCIM connection today.
 *
 * Every operation therefore throws FederationNotEnabled. That is deliberate:
 * a stub that silently returned an empty list would let a caller believe
 * federation "works" and quietly provision nobody.
 */

export class FederationNotEnabled extends Error {
  readonly code = 'federation_not_enabled' as const;

  constructor(capability: string) {
    super(`${capability} is defined as an interface only and is not enabled`);
    this.name = 'FederationNotEnabled';
  }
}

// ── SAML SSO ───────────────────────────────────────────────────────────────

export interface SamlConnectionDescriptor {
  readonly tenantId: string;
  /** IdP entity id — the issuer of assertions this tenant will trust. */
  readonly idpEntityId: string;
  readonly idpSsoUrl: string;
  /** PEM signing certificates; rotation means more than one is valid. */
  readonly idpSigningCertificates: readonly string[];
  readonly spEntityId: string;
  readonly spAcsUrl: string;
  /** Attribute -> claim mapping (email, given name, family name, groups). */
  readonly attributeMap: Readonly<Record<string, string>>;
}

export interface SamlPort {
  describeConnection(tenantId: string): Promise<SamlConnectionDescriptor | null>;
  /**
   * Would verify an assertion's signature, conditions, audience, recipient
   * and replay state, then resolve it to a UserLink. Never implemented here.
   */
  consumeAssertion(input: { tenantId: string; samlResponse: string; relayState: string | null }): Promise<never>;
}

export function createSamlPort(): SamlPort {
  return {
    describeConnection(): Promise<SamlConnectionDescriptor | null> {
      return Promise.reject(new FederationNotEnabled('SAML SSO'));
    },
    consumeAssertion(): Promise<never> {
      return Promise.reject(new FederationNotEnabled('SAML SSO'));
    },
  };
}

// ── SCIM directory sync ────────────────────────────────────────────────────

export interface ScimUserResource {
  readonly externalId: string;
  readonly userName: string;
  readonly active: boolean;
  readonly emails: readonly { value: string; primary?: boolean }[];
  readonly displayName: string | null;
}

export interface ScimGroupResource {
  readonly externalId: string;
  readonly displayName: string;
  readonly memberExternalIds: readonly string[];
}

/**
 * The shape a future SCIM implementation must satisfy. Note what is ABSENT
 * by design: no operation grants a role. Directory sync may create, activate
 * and deactivate UserLinks; RoleBindings stay an explicit internal act, so a
 * compromised directory cannot mint privilege.
 */
export interface ScimPort {
  provisionUser(tenantId: string, user: ScimUserResource): Promise<never>;
  deprovisionUser(tenantId: string, externalId: string): Promise<never>;
  syncGroup(tenantId: string, group: ScimGroupResource): Promise<never>;
}

export function createScimPort(): ScimPort {
  return {
    provisionUser(): Promise<never> {
      return Promise.reject(new FederationNotEnabled('SCIM directory sync'));
    },
    deprovisionUser(): Promise<never> {
      return Promise.reject(new FederationNotEnabled('SCIM directory sync'));
    },
    syncGroup(): Promise<never> {
      return Promise.reject(new FederationNotEnabled('SCIM directory sync'));
    },
  };
}

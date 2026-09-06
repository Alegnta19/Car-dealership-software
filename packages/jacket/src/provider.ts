/**
 * FBL-140 — THE E-SIGN PROVIDER, SIMULATED DETERMINISTICALLY.
 *
 * There is no DocuSign, no Adobe Sign and no notary service behind this
 * platform, and the order is explicit that none may be pretended: a ceremony
 * names `deterministic_simulator` as what stands behind it. What there IS is
 * the seam a real provider would plug into, and the two facts the seam has to
 * carry either way:
 *
 *   * DELIVERY. When a package is sent, each signer's invitation goes THROUGH
 *     the provider. The raw signing link is handed to the provider and to
 *     nobody else — not to the staff response, not to the outbox, not to a log
 *     — because the person who can read the link can sign as the customer, and
 *     that is the lane boundary Outcome 7 draws. The simulator keeps what it
 *     was handed in memory so a test and the journey harness can play the
 *     customer, which is exactly the position a real mailbox would be in.
 *   * REFERENCES. The envelope and delivery references the provider hands back
 *     are DERIVED FROM what was sent, so a replayed send produces the same
 *     reference and is recognised as a replay rather than a second delivery.
 *
 * The provider's callbacks come the other way, through `callbacks.ts`, signed
 * with a shared secret. This module never verifies one; it only knows how to
 * send.
 */
import { sha256Hex } from './hashing';

export interface InvitationDelivery {
  readonly tenantId: string;
  readonly ceremonyId: string;
  readonly signerId: string;
  readonly signerRole: string;
  /** The contact channel, for the provider's own delivery. Never logged here. */
  readonly contactValue: string | null;
  readonly signingUrl: string;
}

export interface DeliveryOutcome {
  readonly outcome: 'delivered' | 'failed';
  readonly deliveryRef: string;
  readonly detail: string | null;
}

export interface EsignProvider {
  readonly providerCode: string;
  readonly kind: 'deterministic_simulator' | 'integrated_provider';
  /** The envelope reference the provider knows the ceremony by. */
  envelopeRef(tenantId: string, ceremonyId: string): string;
  deliverInvitation(delivery: InvitationDelivery): Promise<DeliveryOutcome>;
}

export function simulatedEnvelopeRef(tenantId: string, ceremonyId: string): string {
  return 'ENV-' + sha256Hex(`${tenantId}:${ceremonyId}`).slice(0, 16).toUpperCase();
}

export function simulatedDeliveryRef(signerId: string): string {
  return 'DLV-' + sha256Hex(signerId).slice(0, 16).toUpperCase();
}

/** Addresses the simulator refuses, so a delivery failure can be exercised. */
const UNDELIVERABLE = /^(bounce|invalid|no-such-mailbox)@/i;

const delivered: InvitationDelivery[] = [];

export const simulatedEsignProvider: EsignProvider = {
  providerCode: 'simulated_esign',
  kind: 'deterministic_simulator',
  envelopeRef: simulatedEnvelopeRef,
  async deliverInvitation(delivery: InvitationDelivery): Promise<DeliveryOutcome> {
    const ref = simulatedDeliveryRef(delivery.signerId);
    const value = (delivery.contactValue ?? '').trim();
    if (value.length === 0) {
      return { outcome: 'failed', deliveryRef: ref, detail: 'no contact channel for the signer' };
    }
    if (UNDELIVERABLE.test(value)) {
      return { outcome: 'failed', deliveryRef: ref, detail: 'undeliverable address' };
    }
    delivered.push(delivery);
    return { outcome: 'delivered', deliveryRef: ref, detail: null };
  },
};

/**
 * What the simulator has been handed — the customer's "inbox". A test reads a
 * signing link from here the way a person would read it from their mail, and
 * from nowhere else in the platform.
 */
export function simulatedDeliveries(): readonly InvitationDelivery[] {
  return [...delivered];
}

export function resetSimulatedEsignProviderForTests(): void {
  delivered.length = 0;
}

let active: EsignProvider = simulatedEsignProvider;

export function esignProvider(): EsignProvider {
  return active;
}

/** Test-only: substitute the provider, or restore the simulator with `undefined`. */
export function useEsignProviderForTests(provider: EsignProvider | undefined): void {
  active = provider ?? simulatedEsignProvider;
}

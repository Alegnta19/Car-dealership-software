/**
 * RELEASE TRAIN 2 — THE BOUNDED PROVIDER ADAPTERS.
 *
 * Two outside services this train needs and cannot have: a VIN/build-data
 * decoder and a listing feed. The governing order settles what to do about
 * that — "use deterministic simulators … a simulator must exercise success,
 * rejection, retry, withdrawal, and reconciliation; external certification
 * does not block closure" — so both are modelled as PORTS with a simulator
 * behind them.
 *
 * WHAT MAKES THESE SIMULATORS WORTH ANYTHING is that they are DETERMINISTIC
 * FUNCTIONS OF THEIR INPUT. Nothing here reads a clock, a random source or a
 * counter, so a given VIN always decodes the same way and a given listing
 * always meets the same provider verdict. A test can therefore assert the
 * outcome rather than tolerate whatever came back, and the same input replayed
 * — which is precisely what the outbox does on a retry — produces the same
 * answer instead of a new one.
 *
 * They are also HONEST ABOUT BEING SIMULATORS: every response carries the
 * provider name `simulator`, and nothing in the platform treats a simulated
 * decode as certified manufacturer data.
 */

import { normalizeVin, type VinNormalization } from './vin';

// ── VIN / build data ────────────────────────────────────────────────────────

export interface DecodedBuild {
  readonly modelYear: number | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly trimLevel: string | null;
  readonly bodyStyle: string | null;
  readonly drivetrain: string | null;
  readonly fuelType: string | null;
  readonly transmission: string | null;
  /** Feature codes the build implies, for merchandising. */
  readonly features: readonly { featureCode: string; label: string }[];
}

export interface VinDecodeResult {
  readonly provider: string;
  readonly outcome: 'decoded' | 'rejected' | 'unavailable';
  readonly build: DecodedBuild | null;
  /** Bounded, human-readable; safe to show staff and to store. */
  readonly message: string | null;
}

export interface VinDecodePort {
  readonly provider: string;
  decode(vin: string, referenceYear: number): Promise<VinDecodeResult>;
}

/**
 * World Manufacturer Identifiers the simulator knows. Real decoders resolve
 * thousands; this one resolves enough to demonstrate the journey and to give
 * the batteries stable, meaningful values to assert on.
 */
const KNOWN_WMI: Readonly<Record<string, { make: string; model: string; body: string }>> = {
  '1HG': { make: 'Honda', model: 'Accord', body: 'sedan' },
  '2HG': { make: 'Honda', model: 'Civic', body: 'sedan' },
  '1FA': { make: 'Ford', model: 'Mustang', body: 'coupe' },
  '1FT': { make: 'Ford', model: 'F-150', body: 'pickup' },
  '1G1': { make: 'Chevrolet', model: 'Malibu', body: 'sedan' },
  '1GC': { make: 'Chevrolet', model: 'Silverado', body: 'pickup' },
  JTD: { make: 'Toyota', model: 'Prius', body: 'hatchback' },
  '4T1': { make: 'Toyota', model: 'Camry', body: 'sedan' },
  '5YJ': { make: 'Tesla', model: 'Model 3', body: 'sedan' },
  WBA: { make: 'BMW', model: '330i', body: 'sedan' },
  WDD: { make: 'Mercedes-Benz', model: 'C300', body: 'sedan' },
  KMH: { make: 'Hyundai', model: 'Elantra', body: 'sedan' },
};

/** Trim and drivetrain are derived from fixed VIN positions, so they are stable per VIN. */
const TRIMS = ['Base', 'LX', 'EX', 'Sport', 'Limited', 'Touring'] as const;
const DRIVETRAINS = ['fwd', 'rwd', 'awd', '4wd'] as const;

function charCode(vin: string, index: number): number {
  return (vin.charCodeAt(index) - 48 + 36) % 36;
}

/**
 * The decode simulator.
 *
 * Its three outcomes are reachable by construction, which is what the order
 * asks a simulator to prove:
 *   * REJECTED — the VIN is not a VIN (shape) or its WMI is one the provider
 *     does not carry, which is the real-world "unknown manufacturer" answer;
 *   * UNAVAILABLE — a VIN whose eleventh character is '0' stands for the
 *     provider being up but having no build record, so the retry path has
 *     something to retry that is not an error;
 *   * DECODED — everything else, with a build derived from the VIN itself.
 */
export const simulatedVinDecoder: VinDecodePort = {
  provider: 'simulator',
  async decode(vin: string, referenceYear: number): Promise<VinDecodeResult> {
    const normalized: VinNormalization = normalizeVin(vin, referenceYear);
    if (normalized.vin === null) {
      return {
        provider: 'simulator',
        outcome: 'rejected',
        build: null,
        message: 'the VIN is not well formed',
      };
    }
    const clean = normalized.vin;
    const known = KNOWN_WMI[clean.slice(0, 3)];
    if (known === undefined) {
      return {
        provider: 'simulator',
        outcome: 'rejected',
        build: null,
        message: `no build data is published for manufacturer identifier ${clean.slice(0, 3)}`,
      };
    }
    if (clean[10] === '0') {
      return {
        provider: 'simulator',
        outcome: 'unavailable',
        build: null,
        message: 'build data is temporarily unavailable for this VIN',
      };
    }

    const electric = known.make === 'Tesla';
    const features = [
      { featureCode: 'air_conditioning', label: 'Air conditioning' },
      { featureCode: 'bluetooth', label: 'Bluetooth' },
    ];
    if (charCode(clean, 12) % 2 === 0) {
      features.push({ featureCode: 'heated_seats', label: 'Heated seats' });
    }
    if (charCode(clean, 13) % 3 === 0) {
      features.push({ featureCode: 'sunroof', label: 'Sunroof' });
    }
    if (electric) features.push({ featureCode: 'fast_charging', label: 'DC fast charging' });

    return {
      provider: 'simulator',
      outcome: 'decoded',
      build: {
        modelYear: normalized.modelYear,
        make: known.make,
        model: known.model,
        trimLevel: TRIMS[charCode(clean, 7) % TRIMS.length] as string,
        bodyStyle: known.body,
        drivetrain: DRIVETRAINS[charCode(clean, 6) % DRIVETRAINS.length] as string,
        fuelType: electric ? 'electric' : charCode(clean, 5) % 5 === 0 ? 'hybrid' : 'gasoline',
        transmission: electric ? 'other' : charCode(clean, 4) % 4 === 0 ? 'manual' : 'automatic',
        features,
      },
      message: null,
    };
  },
};

// ── listing feed ────────────────────────────────────────────────────────────

/**
 * What the listing provider is shown. IDS AND MERCHANDISING ONLY: no party,
 * no cost, no acquisition source. A feed does not need to know what the
 * dealership paid or who sold them the car, and this shape is what stops that
 * from leaking by accident.
 */
export interface ListingSubmission {
  readonly listingId: string;
  readonly channel: string;
  readonly stockNumber: string;
  readonly vin: string;
  readonly modelYear: number | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly priceCents: number | null;
  readonly photoCount: number;
  readonly attempt: number;
}

export interface ListingOutcome {
  readonly outcome: 'accepted' | 'rejected' | 'deferred';
  /** The provider's own identifier, present only on acceptance. */
  readonly providerRef: string | null;
  readonly message: string | null;
}

export interface ListingPort {
  readonly provider: string;
  publish(submission: ListingSubmission): Promise<ListingOutcome>;
  withdraw(listingId: string, providerRef: string | null): Promise<ListingOutcome>;
  /** What the provider believes it is currently carrying, for reconciliation. */
  describe(listingId: string, providerRef: string | null): Promise<ListingOutcome>;
}

/**
 * The provider reference is a pure function of the listing id, so a REPLAYED
 * publication returns the SAME reference the first one did. That is what makes
 * an at-least-once delivery safe to reconcile: the platform can tell "this is
 * the listing we already have" from "this is a second listing".
 */
export function simulatedProviderRef(listingId: string): string {
  return 'SIM-' + listingId.replace(/-/g, '').slice(0, 12).toUpperCase();
}

/**
 * The listing simulator, whose verdicts are reachable and deterministic:
 *
 *   * REJECTED — a vehicle with no price, or with no photograph, is refused,
 *     which is what every real feed does and what gives the rejection path a
 *     cause staff can actually fix;
 *   * DEFERRED — the FIRST attempt on a channel named `slow_channel` is a
 *     transient failure, and the retry succeeds. One channel carries the retry
 *     behaviour so the other channels stay predictable;
 *   * ACCEPTED — otherwise, with a reference derived from the listing id.
 */
export const simulatedListingProvider: ListingPort = {
  provider: 'simulator',
  async publish(submission: ListingSubmission): Promise<ListingOutcome> {
    if (submission.priceCents === null) {
      return {
        outcome: 'rejected',
        providerRef: null,
        message: 'a listing needs a published price',
      };
    }
    if (submission.photoCount < 1) {
      return {
        outcome: 'rejected',
        providerRef: null,
        message: 'a listing needs at least one photograph',
      };
    }
    if (submission.channel === 'slow_channel' && submission.attempt <= 1) {
      return {
        outcome: 'deferred',
        providerRef: null,
        message: 'the channel is busy; retry shortly',
      };
    }
    return {
      outcome: 'accepted',
      providerRef: simulatedProviderRef(submission.listingId),
      message: null,
    };
  },
  async withdraw(listingId: string, providerRef: string | null): Promise<ListingOutcome> {
    // Withdrawing something the provider never accepted is not an error: the
    // end state the dealership asked for — not listed — already holds.
    if (providerRef === null) {
      return { outcome: 'accepted', providerRef: null, message: 'nothing was published' };
    }
    return { outcome: 'accepted', providerRef, message: null };
  },
  async describe(listingId: string, providerRef: string | null): Promise<ListingOutcome> {
    return providerRef === null
      ? { outcome: 'rejected', providerRef: null, message: 'the provider carries no such listing' }
      : { outcome: 'accepted', providerRef, message: null };
  },
};

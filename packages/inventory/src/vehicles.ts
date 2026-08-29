/**
 * RELEASE TRAIN 2, ROW 2 (first half) — THE CANONICAL VEHICLE.
 *
 * A vehicle is the thing in the world; a stock item is this dealership's
 * holding of it. Keeping them apart is what lets the same car be traded in,
 * sold and traded in again years later WITHOUT REKEYING ITS IDENTITY: the
 * second acquisition finds the existing vehicle row by VIN and hangs a new
 * stock record off it, so the decode, the features and the history all carry
 * forward.
 *
 * `resolveVehicleByVin` is therefore the only way a vehicle comes into being.
 * It is find-or-create, it runs inside the caller's transaction so an
 * acquisition is atomic, and it is safe to race: the unique index on
 * (tenant_id, vin) is the authority, and a lost race re-reads rather than
 * failing.
 */
import { withTenantTransaction, type Executor } from '@dealer/database';
import { recordMutation, requireActor, type MutationResult } from '@dealer/identity-access';
import { describeVinRejection, normalizeVin } from './vin';
import { simulatedVinDecoder, type VinDecodePort } from './providers';

interface Row {
  [key: string]: unknown;
}

export type DecodeStatus = 'undecoded' | 'decoded' | 'rejected' | 'unavailable';

export interface VehicleView {
  readonly vehicleId: string;
  readonly vin: string;
  readonly vinCheckDigitValid: boolean;
  readonly modelYear: number | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly trimLevel: string | null;
  readonly bodyStyle: string | null;
  readonly drivetrain: string | null;
  readonly fuelType: string | null;
  readonly transmission: string | null;
  readonly exteriorColor: string | null;
  readonly interiorColor: string | null;
  readonly decodeStatus: DecodeStatus;
  readonly decodedAt: string | null;
  readonly decodeSource: string | null;
  readonly authorizationVersion: number;
}

const VEHICLE_COLUMNS = `vehicle_id, vin, vin_check_digit_valid, model_year, make, model,
       trim_level, body_style, drivetrain, fuel_type, transmission, exterior_color,
       interior_color, decode_status, decoded_at, decode_source, authorization_version`;

export function mapVehicle(row: Row): VehicleView {
  return {
    vehicleId: String(row.vehicle_id),
    vin: String(row.vin),
    vinCheckDigitValid: row.vin_check_digit_valid === true,
    modelYear: row.model_year === null ? null : Number(row.model_year),
    make: row.make === null ? null : String(row.make),
    model: row.model === null ? null : String(row.model),
    trimLevel: row.trim_level === null ? null : String(row.trim_level),
    bodyStyle: row.body_style === null ? null : String(row.body_style),
    drivetrain: row.drivetrain === null ? null : String(row.drivetrain),
    fuelType: row.fuel_type === null ? null : String(row.fuel_type),
    transmission: row.transmission === null ? null : String(row.transmission),
    exteriorColor: row.exterior_color === null ? null : String(row.exterior_color),
    interiorColor: row.interior_color === null ? null : String(row.interior_color),
    decodeStatus: String(row.decode_status) as DecodeStatus,
    decodedAt: row.decoded_at === null ? null : new Date(row.decoded_at as string).toISOString(),
    decodeSource: row.decode_source === null ? null : String(row.decode_source),
    authorizationVersion: Number(row.authorization_version),
  };
}

export type VehicleResolution =
  | { outcome: 'resolved'; vehicle: VehicleView; created: boolean; mutation: MutationResult | null }
  | { outcome: 'invalid'; error: string };

/**
 * Finds the dealership's vehicle for this VIN, creating it if this is the
 * first time the VIN has been seen. Runs inside the CALLER'S transaction.
 *
 * The `referenceYear` is passed in rather than read from a clock so the
 * model-year cycle resolves deterministically — the same VIN decoded in a test
 * and in production against the same reference gives the same year.
 */
export async function resolveVehicleByVin(
  executor: Executor,
  input: {
    actingUserLinkId: string;
    tenantId: string;
    vin: unknown;
    referenceYear: number;
  },
): Promise<VehicleResolution> {
  const normalized = normalizeVin(input.vin, input.referenceYear);
  if (normalized.vin === null) {
    return { outcome: 'invalid', error: describeVinRejection(normalized.rejection ?? 'empty') };
  }
  const actor = await requireActor(executor, input.actingUserLinkId);

  const existing = await executor.query(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE tenant_id = $1 AND vin = $2`,
    [input.tenantId, normalized.vin],
  );
  if (existing.rows.length > 0) {
    return {
      outcome: 'resolved',
      vehicle: mapVehicle(existing.rows[0] as Row),
      created: false,
      mutation: null,
    };
  }

  // The model year is the ONE fact readable from the VIN itself, so a vehicle
  // is never created completely blank even when no decoder is reachable.
  const written = await executor.query(
    `INSERT INTO vehicles
       (tenant_id, vin, vin_check_digit_valid, model_year,
        created_by_user_link_id, updated_by_user_link_id)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id, vin) DO NOTHING
     RETURNING ${VEHICLE_COLUMNS}`,
    [input.tenantId, normalized.vin, normalized.checkDigitValid, normalized.modelYear, actor],
  );
  if (written.rows.length === 0) {
    // Lost the race to a concurrent acquisition of the same VIN. The other
    // transaction's row is the canonical one; re-read rather than fail.
    const raced = await executor.query(
      `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE tenant_id = $1 AND vin = $2`,
      [input.tenantId, normalized.vin],
    );
    if (raced.rows.length === 0) {
      return { outcome: 'invalid', error: 'the vehicle could not be resolved' };
    }
    return {
      outcome: 'resolved',
      vehicle: mapVehicle(raced.rows[0] as Row),
      created: false,
      mutation: null,
    };
  }

  const vehicle = mapVehicle(written.rows[0] as Row);
  const mutation = await recordMutation(executor, {
    tenantId: input.tenantId,
    entityType: 'vehicle',
    entityId: vehicle.vehicleId,
    eventType: 'inventory.vehicle.created',
    actingUserLinkId: actor,
    authorizationVersion: vehicle.authorizationVersion,
    details: { vin_check_digit_valid: vehicle.vinCheckDigitValid },
  });
  return { outcome: 'resolved', vehicle, created: true, mutation };
}

export type VehicleDecodeOutcome =
  | {
      outcome: 'decoded';
      vehicle: VehicleView;
      features: readonly { featureCode: string; label: string }[];
      mutation: MutationResult;
    }
  | { outcome: 'rejected' | 'unavailable'; message: string; vehicle: VehicleView }
  | { outcome: 'not_found' };

/**
 * Decodes a vehicle's build through the provider port and records the attempt.
 *
 * EVERY ATTEMPT LANDS IN `vehicle_decodes`, accepted or not, so a decoded
 * vehicle can be traced to the response that decoded it and a rejection is
 * visible instead of being silently retried away. Only a successful decode
 * touches the vehicle row, and it never overwrites a value staff have set by
 * hand: the decode fills what is empty (COALESCE keeps the existing value),
 * because the person looking at the car outranks the provider.
 */
export async function decodeVehicle(input: {
  actingUserLinkId: string;
  tenantId: string;
  vehicleId: string;
  referenceYear: number;
  decoder?: VinDecodePort | undefined;
}): Promise<VehicleDecodeOutcome> {
  const decoder = input.decoder ?? simulatedVinDecoder;
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const found = await executor.query(
      `SELECT ${VEHICLE_COLUMNS} FROM vehicles
        WHERE tenant_id = $1 AND vehicle_id = $2 FOR UPDATE`,
      [input.tenantId, input.vehicleId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const before = mapVehicle(found.rows[0] as Row);

    const result = await decoder.decode(before.vin, input.referenceYear);
    await executor.query(
      `INSERT INTO vehicle_decodes
         (tenant_id, vehicle_id, provider, vin, outcome, attributes, message,
          requested_by_user_link_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.tenantId,
        before.vehicleId,
        result.provider,
        before.vin,
        result.outcome,
        JSON.stringify(result.build ?? {}),
        result.message,
        actor,
      ],
    );

    if (result.outcome !== 'decoded' || result.build === null) {
      // A provider that answers 'decoded' with no build is treated as
      // UNAVAILABLE rather than trusted: an empty success is not a decode, and
      // recording it as one would claim knowledge nothing supplied.
      const status: 'rejected' | 'unavailable' =
        result.outcome === 'rejected' ? 'rejected' : 'unavailable';
      const marked = await executor.query(
        `UPDATE vehicles
            SET decode_status = $3, updated_by_user_link_id = $4, updated_at = NOW(),
                authorization_version = authorization_version + 1
          WHERE tenant_id = $1 AND vehicle_id = $2
          RETURNING ${VEHICLE_COLUMNS}`,
        [input.tenantId, before.vehicleId, status, actor],
      );
      return {
        outcome: status,
        message: result.message ?? 'the provider returned no build data',
        vehicle: mapVehicle(marked.rows[0] as Row),
      };
    }

    const b = result.build;
    const updated = await executor.query(
      `UPDATE vehicles
          SET model_year = COALESCE(model_year, $3),
              make = COALESCE(make, $4),
              model = COALESCE(model, $5),
              trim_level = COALESCE(trim_level, $6),
              body_style = COALESCE(body_style, $7),
              drivetrain = COALESCE(drivetrain, $8),
              fuel_type = COALESCE(fuel_type, $9),
              transmission = COALESCE(transmission, $10),
              decode_status = 'decoded',
              decoded_at = NOW(),
              decode_source = $11,
              updated_by_user_link_id = $12, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND vehicle_id = $2
        RETURNING ${VEHICLE_COLUMNS}`,
      [
        input.tenantId,
        before.vehicleId,
        b.modelYear,
        b.make,
        b.model,
        b.trimLevel,
        b.bodyStyle,
        b.drivetrain,
        b.fuelType,
        b.transmission,
        result.provider,
        actor,
      ],
    );
    const vehicle = mapVehicle(updated.rows[0] as Row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'vehicle',
      entityId: vehicle.vehicleId,
      eventType: 'inventory.vehicle.decoded',
      actingUserLinkId: actor,
      authorizationVersion: vehicle.authorizationVersion,
      details: { provider: result.provider, decode_outcome: 'decoded' },
    });
    return { outcome: 'decoded' as const, vehicle, features: b.features, mutation };
  });
}

export type VehicleUpdateOutcome =
  | { outcome: 'saved'; vehicle: VehicleView; mutation: MutationResult }
  | { outcome: 'version_conflict'; currentVersion: number }
  | { outcome: 'not_found' };

/**
 * Corrects what the decode could not know — the colours a person reads off the
 * car. The VIN itself is NOT editable: changing it would rekey the canonical
 * identity, which row 2 forbids, and a wrong VIN is corrected by acquiring the
 * right vehicle rather than by rewriting this one.
 */
export async function updateVehicleAppearance(input: {
  actingUserLinkId: string;
  tenantId: string;
  vehicleId: string;
  expectedVersion: number;
  exteriorColor?: string | null | undefined;
  interiorColor?: string | null | undefined;
}): Promise<VehicleUpdateOutcome> {
  return withTenantTransaction(input.tenantId, async (executor) => {
    const actor = await requireActor(executor, input.actingUserLinkId);
    const found = await executor.query(
      `SELECT ${VEHICLE_COLUMNS} FROM vehicles
        WHERE tenant_id = $1 AND vehicle_id = $2 FOR UPDATE`,
      [input.tenantId, input.vehicleId],
    );
    if (found.rows.length === 0) return { outcome: 'not_found' as const };
    const current = mapVehicle(found.rows[0] as Row);
    if (current.authorizationVersion !== input.expectedVersion) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const updated = await executor.query(
      `UPDATE vehicles
          SET exterior_color = $3, interior_color = $4,
              updated_by_user_link_id = $5, updated_at = NOW(),
              authorization_version = authorization_version + 1
        WHERE tenant_id = $1 AND vehicle_id = $2 AND authorization_version = $6
        RETURNING ${VEHICLE_COLUMNS}`,
      [
        input.tenantId,
        input.vehicleId,
        input.exteriorColor === undefined ? current.exteriorColor : input.exteriorColor,
        input.interiorColor === undefined ? current.interiorColor : input.interiorColor,
        actor,
        input.expectedVersion,
      ],
    );
    if (updated.rows.length === 0) {
      return { outcome: 'version_conflict' as const, currentVersion: current.authorizationVersion };
    }
    const vehicle = mapVehicle(updated.rows[0] as Row);
    const mutation = await recordMutation(executor, {
      tenantId: input.tenantId,
      entityType: 'vehicle',
      entityId: vehicle.vehicleId,
      eventType: 'inventory.vehicle.updated',
      actingUserLinkId: actor,
      authorizationVersion: vehicle.authorizationVersion,
      details: {},
    });
    return { outcome: 'saved' as const, vehicle, mutation };
  });
}

export async function getVehicle(tenantId: string, vehicleId: string): Promise<VehicleView | null> {
  return withTenantTransaction(tenantId, async (tx) => {
    const found = await tx.query(
      `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE tenant_id = $1 AND vehicle_id = $2`,
      [tenantId, vehicleId],
    );
    return found.rows.length === 0 ? null : mapVehicle(found.rows[0] as Row);
  });
}

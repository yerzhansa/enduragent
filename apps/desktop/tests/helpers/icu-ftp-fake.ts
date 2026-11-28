import { canonicalJson } from "@enduragent/kernel/archive";
import { createIntervalsSourceRepository, H, type SqlStore } from "@enduragent/kernel/store";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import {
  sportSettingsBody,
  type IcuRideSettings,
  type IcuSportSettingsPort,
} from "../../../../packages/coach/src/one-ftp-icu.js";

const ATHLETE = "i1998";
const RIDE_TYPES = ["Ride", "VirtualRide", "GravelRide"];
const crypto = createNodeCrypto();

function repository(store: SqlStore) {
  return createIntervalsSourceRepository(store, (fields) =>
    H(crypto, ...(fields as [string | number, ...(string | number)[]])),
  );
}

function isoDay(dateKey: number): string {
  const text = String(dateKey);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export interface IcuRideSettingsFixture {
  readonly id: number;
  readonly ftp: number | null;
  readonly indoorFtp: number | null;
  readonly updated: string;
  readonly athleteId?: string;
}

export function rideSettingsWire(settings: IcuRideSettingsFixture) {
  return {
    id: settings.id,
    athlete_id: settings.athleteId ?? ATHLETE,
    types: RIDE_TYPES,
    ftp: settings.ftp,
    indoor_ftp: settings.indoorFtp,
    updated: settings.updated,
  };
}

export async function landIcuRideSettings(
  store: SqlStore,
  settings: IcuRideSettingsFixture,
): Promise<void> {
  const sources = repository(store);
  const externalId = `settings:${canonicalJson([
    settings.id,
    settings.athleteId ?? ATHLETE,
    RIDE_TYPES,
    settings.updated,
  ])}`;
  const address = await H(crypto, "fixture-settings", externalId);
  const { artifactKey } = await sources.recordArtifact({
    source: "intervals-icu",
    lane: "settings",
    externalId,
    artifactKind: "snapshot",
    archiveAddress: address,
    archiveRelPath: `synthetic/settings/${address}.json`,
    archiveEpochSeconds: Math.floor(Date.parse(settings.updated) / 1_000),
  });
  await sources.recordGenericLanding({
    externalId,
    artifactKey,
    archiveAddress: address,
    endpoint: "settings",
    normalizedPayloadJson: canonicalJson(rideSettingsWire(settings)),
  });
}

export async function landIcuStreams(
  store: SqlStore,
  providerActivityId: string,
  streams: { readonly time: readonly number[]; readonly watts: readonly (number | null)[] },
): Promise<void> {
  const sources = repository(store);
  const externalId = `streams:${providerActivityId}`;
  const address = await H(crypto, "fixture-streams", externalId);
  const { artifactKey } = await sources.recordArtifact({
    source: "intervals-icu",
    lane: "streams",
    externalId,
    artifactKind: "snapshot",
    archiveAddress: address,
    archiveRelPath: `synthetic/streams/${address}.json`,
    archiveEpochSeconds: 0,
  });
  await sources.recordGenericLanding({
    externalId,
    artifactKey,
    archiveAddress: address,
    endpoint: "streams",
    normalizedPayloadJson: canonicalJson({ time: [...streams.time], watts: [...streams.watts] }),
  });
}

export async function landIcuEstimate(
  store: SqlStore,
  dateKey: number,
  eftp: number,
): Promise<void> {
  const day = isoDay(dateKey);
  await repository(store).upsertWellness({
    id: await H(crypto, "wellness", dateKey, "intervals-icu"),
    date_key: dateKey,
    provenance: "sync",
    source: "intervals-icu",
    resting_hr: null,
    hrv: null,
    hrv_sdnn: null,
    sleep_s: null,
    sleep_score: null,
    weight_kg: null,
    soreness: null,
    fatigue: null,
    fields_json: canonicalJson({
      source: "intervals-icu",
      subjectiveFatigue: null,
      load: {
        fitness: null,
        fatigue: null,
        fitnessContribution: null,
        fatigueContribution: null,
        weeklyFitnessChange: null,
      },
      values: { id: day, sportInfo: [{ type: "Ride", eftp, wPrime: 18_000, pMax: 900 }] },
    }),
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  });
}

export interface FakeIcuWrite {
  readonly settingsId: number;
  readonly watts: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface FakeIcuSportSettings {
  readonly port: IcuSportSettingsPort;
  readonly writes: FakeIcuWrite[];
  settings: IcuRideSettingsFixture;
  extra: Readonly<Record<string, unknown>>;
  failReads: number;
  failWrites: number;
  loseWriteAnswers: number;
  reads: number;
  onRead: ((count: number) => void) | null;
}

export const FAKE_SETTINGS_EXTRA = Object.freeze({
  lthr: 168,
  max_hr: 188,
  w_prime: 18_500,
  power_zones: [55, 75, 90, 105, 120, 150, 999],
  hr_zones: [137, 153, 160, 168, 172, 177, 188],
  sweet_spot_min: 84,
  sweet_spot_max: 97,
  sft_ftp: 280,
});

export function createFakeIcuSportSettings(
  initial: IcuRideSettingsFixture,
  clock: () => number,
): FakeIcuSportSettings {
  const read = (settings: IcuRideSettingsFixture): IcuRideSettings => {
    const record = { ...fake.extra, ...rideSettingsWire(settings) };
    return {
      settingsId: settings.id,
      ftpWatts: settings.ftp,
      indoorFtpWatts: settings.indoorFtp,
      updatedMs: Date.parse(settings.updated),
      record,
    };
  };
  const fake: FakeIcuSportSettings = {
    writes: [],
    settings: initial,
    extra: FAKE_SETTINGS_EXTRA,
    failReads: 0,
    failWrites: 0,
    loseWriteAnswers: 0,
    reads: 0,
    onRead: null,
    port: {
      async readRide() {
        fake.reads += 1;
        fake.onRead?.(fake.reads);
        if (fake.failReads > 0) {
          fake.failReads -= 1;
          throw new Error("Synthetic intervals.icu did not answer");
        }
        return read(fake.settings);
      },
      async writeRideFtp(input) {
        if (fake.failWrites > 0) {
          fake.failWrites -= 1;
          throw new Error("Synthetic intervals.icu did not answer");
        }
        if (input.settings.settingsId !== fake.settings.id)
          throw new Error("Unknown sport settings");
        const body = sportSettingsBody(input.settings, input.watts);
        fake.writes.push({ settingsId: input.settings.settingsId, watts: input.watts, body });
        fake.settings = {
          ...fake.settings,
          ftp: input.watts,
          updated: new Date(clock()).toISOString().replace("Z", "+00:00"),
        };
        if (fake.loseWriteAnswers > 0) {
          fake.loseWriteAnswers -= 1;
          throw new Error("Synthetic intervals.icu answer was lost");
        }
        return read(fake.settings);
      },
    },
  };
  return fake;
}

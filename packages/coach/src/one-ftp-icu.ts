import type { IntervalsClient } from "intervals-icu-api";
import { z } from "zod";

export interface IcuRideSettings {
  readonly settingsId: number;
  readonly ftpWatts: number | null;
  readonly indoorFtpWatts: number | null;
  readonly updatedMs: number | null;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface IcuSportSettingsPort {
  readRide(): Promise<IcuRideSettings>;
  writeRideFtp(input: {
    readonly settings: IcuRideSettings;
    readonly watts: number;
  }): Promise<IcuRideSettings>;
}

const SportSettingsSchema = z
  .object({
    id: z.number().int().nonnegative(),
    ftp: z.number().nullish(),
    indoor_ftp: z.number().nullish(),
    updated: z.string().nullish(),
  })
  .passthrough();

function watts(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 9_999
    ? Math.round(value)
    : null;
}

export function icuRideSettings(value: unknown): IcuRideSettings {
  const parsed = SportSettingsSchema.parse(value);
  const updatedMs = typeof parsed.updated === "string" ? Date.parse(parsed.updated) : Number.NaN;
  return {
    settingsId: parsed.id,
    ftpWatts: watts(parsed.ftp),
    indoorFtpWatts: watts(parsed.indoor_ftp),
    updatedMs: Number.isFinite(updatedMs) ? updatedMs : null,
    record: parsed,
  };
}

export function sportSettingsBody(
  settings: IcuRideSettings,
  ftpWatts: number,
): Readonly<Record<string, unknown>> {
  const body = Object.fromEntries(
    Object.entries(settings.record).filter(([field]) => field !== "id"),
  );
  return { ...body, ftp: ftpWatts };
}

function settingsPath(client: IntervalsClient, settings: string): string {
  return `/api/v1/athlete/${encodeURIComponent(client.athleteId)}/sport-settings/${encodeURIComponent(settings)}`;
}

export function createIcuSportSettingsPort(
  readClient: () => IntervalsClient | null,
): IcuSportSettingsPort {
  const client = (): IntervalsClient => {
    const value = readClient();
    if (value === null) throw new Error("Intervals credentials are required.");
    return value;
  };
  const value = (result: Awaited<ReturnType<IntervalsClient["request"]>>): IcuRideSettings => {
    if (!result.ok)
      throw new Error("Intervals sport settings request failed.", { cause: result.error });
    return icuRideSettings(result.value.data);
  };
  return Object.freeze({
    async readRide() {
      const intervals = client();
      return value(
        await intervals.request(settingsPath(intervals, "Ride"), {
          method: "GET",
          hookPath: "/api/v1/athlete/{id}/sport-settings/{settings}",
        }),
      );
    },
    async writeRideFtp(input: { readonly settings: IcuRideSettings; readonly watts: number }) {
      const intervals = client();
      return value(
        await intervals.request(settingsPath(intervals, String(input.settings.settingsId)), {
          method: "PUT",
          query: { recalcHrZones: false },
          json: sportSettingsBody(input.settings, input.watts),
          retry: "never",
          hookPath: "/api/v1/athlete/{id}/sport-settings/{settings}",
        }),
      );
    },
  });
}

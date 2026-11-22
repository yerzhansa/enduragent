import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "z".repeat(43);
const DEVICE_ZONE = "Asia/Qyzylorda";
const fixtures: RunningDesktopFixture[] = [];

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function makeScript(): DesktopFixtureScript {
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: { provider: "anthropic", model: "fixture", credential_configured: true },
          intervals: {
            athlete_id: "0",
            credential_configured: false,
            managedByEnvironment: { athleteId: false },
          },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
            managedByEnvironment: {
              historyTokenBudgetRatio: false,
              idleMinutes: false,
              dailyResetHour: false,
              resetArchiveRetentionDays: false,
              timezone: false,
            },
          },
        });
      }
      if (request.method === "getSetupStatus") {
        return response({
          schemaVersion: 1,
          durableTrainingData: true,
        });
      }
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "listArchivedConversations") {
        return response({ schemaVersion: 1, conversations: [], nextCursor: null });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "hasSession") {
        return response({ hasSession: false });
      }
      if (request.method === "getSpendSummary") {
        return response({
          schemaVersion: 1,
          currency: "USD",
          today: { spend: 0, cap: null },
          routes: [],
        });
      }
      return response({ schemaVersion: 1 });
    },
  };
}

async function launch(input: {
  readonly seedConfig: boolean;
  readonly pinned: false | "embedded" | "legacy";
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<RunningDesktopFixture> {
  const fixture = await launchDesktopFixture({
    script: makeScript(),
    token,
    width: 1180,
    height: 840,
    colorScheme: "light",
    reducedMotion: true,
    sessionTimezonePinned: input.pinned,
    seedConfig: input.seedConfig,
    ...(input.extraEnv === undefined ? {} : { extraEnv: input.extraEnv }),
  });
  fixtures.push(fixture);
  return fixture;
}

async function persistedPin(fixture: RunningDesktopFixture): Promise<string> {
  try {
    return await readFile(fixture.paths.sessionTimezonePinPath, "utf8");
  } catch {
    return "absent";
  }
}

async function storedZone(fixture: RunningDesktopFixture): Promise<string | "absent"> {
  try {
    const document = parseYaml(await readFile(fixture.paths.configPath, "utf8")) as {
      readonly session?: { readonly timezone?: unknown };
    };
    return String(document.session?.timezone);
  } catch {
    return "absent";
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf((process.platform !== "darwin" && process.platform !== "win32") || !hasLoopback)(
  "desktop session timezone startup",
  () => {
    it("adopts this computer's timezone into an unpinned config at start", async () => {
      const fixture = await launch({
        seedConfig: true,
        pinned: false,
        extraEnv: { TZ: DEVICE_ZONE },
      });

      expect(await storedZone(fixture)).toEqual(DEVICE_ZONE);
      expect(await persistedPin(fixture)).toEqual("absent");
    }, 90_000);

    it("keeps a timezone pinned in config when this computer reports a different one", async () => {
      const fixture = await launch({
        seedConfig: true,
        pinned: "embedded",
        extraEnv: { TZ: DEVICE_ZONE },
      });

      expect(await storedZone(fixture)).toEqual("UTC");
      expect(await persistedPin(fixture)).toEqual("absent");
    }, 90_000);

    it("keeps a timezone pinned by the legacy sidecar", async () => {
      const fixture = await launch({
        seedConfig: true,
        pinned: "legacy",
        extraEnv: { TZ: DEVICE_ZONE },
      });

      expect(await storedZone(fixture)).toEqual("UTC");
      expect(await persistedPin(fixture)).toEqual('{"schemaVersion":1,"pinned":true}\n');
    }, 90_000);

    it("leaves the stored zone and the pin alone when COACH_TZ owns the timezone", async () => {
      const fixture = await launch({
        seedConfig: true,
        pinned: false,
        extraEnv: { TZ: DEVICE_ZONE, COACH_TZ: "Europe/Berlin" },
      });

      expect(await storedZone(fixture)).toEqual("UTC");
      expect(await persistedPin(fixture)).toEqual("absent");
    }, 90_000);
  },
);

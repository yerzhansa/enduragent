import { describe, expect, it } from "vitest";
import {
  createMissingPlatformCalendarMutations,
  type AthleteDataReader,
  type CoreDeps,
} from "@enduragent/core";
import { cyclingSport } from "../src/sport.js";
import { createCyclingTools } from "../src/tools.js";

function tomorrowISODate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const reader: AthleteDataReader = {
  getAthlete: async () => ({ ok: true, value: {} }),
  listWellness: async () => ({ ok: true, value: [] }),
  listActivities: async () => ({ ok: true, value: [{ id: "store" }] }),
  getActivity: async () => ({ ok: true, value: {} }),
  getStreams: async () => ({ ok: true, value: {} }),
  listCalendar: async () => ({
    ok: false,
    error: "store_read_unavailable",
    message: "Calendar reads are not available from the local training store.",
  }),
  freshness: () => undefined,
};

describe("cycling data-source tools", () => {
  it("routes the cycling activity registration through the selected reader", async () => {
    const deps = {
      llm: {},
      intervals: null,
      athleteData: reader,
      calendarMutations: createMissingPlatformCalendarMutations(),
      memory: {},
      secrets: {},
      tz: "UTC",
    } as CoreDeps;
    const registration = cyclingSport
      .tools(deps)
      .find((item) => item.name === "intervals_fetch_activities")!;
    expect(registration.description).toContain("recorded activity summaries");
    expect(registration.description).toContain("bounded source-neutral");
    expect(registration.description).toContain("other readers");
    expect(registration.description).toContain("narrow the date range");
    expect(registration.description).not.toContain("intervals.icu");
    expect(registration.description).not.toContain("load, intensity");
    await expect(
      registration.tool.execute!({ oldest: "1998-01-01", newest: "1998-07-18" }, {} as never),
    ).resolves.toEqual([{ id: "store" }]);
  });

  it("keeps create registered and returns the exact missing-credential error", async () => {
    const tools = createCyclingTools(
      {} as never,
      null,
      "UTC",
      createMissingPlatformCalendarMutations(),
    );
    const result = await tools.intervals_create_workout!.execute!(
      {
        date: tomorrowISODate(),
        workout: {
          name: "Synthetic",
          steps: [
            {
              type: "steady",
              duration: { value: 5, unit: "minutes" },
              power: { kind: "percent_ftp", value: 70 },
            },
          ],
        },
      },
      {} as never,
    );
    expect(result).toEqual({
      error: "platform_credentials_required",
      message: "Calendar changes need platform credentials.",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createCyclingPlanFtpAdapter,
  readCyclingPlanFtpCandidates,
  validateManualPlanFtp,
} from "../src/plan-ftp.js";

const value = (watts: number) => ({ watts, refreshedAtMs: 1_000 });

describe("cycling Plan FTP adapter", () => {
  it.each([
    {
      manual: 210,
      ftp: null,
      eftp: null,
      expected: [{ source: "manual", watts: 210, selected: true }],
    },
    {
      manual: null,
      ftp: 215,
      eftp: null,
      expected: [{ source: "intervals-ftp", watts: 215, selected: true }],
    },
    {
      manual: null,
      ftp: null,
      eftp: 220,
      expected: [{ source: "intervals-eftp", watts: 220, selected: true }],
    },
    {
      manual: 210,
      ftp: 215,
      eftp: 220,
      expected: [
        { source: "manual", watts: 210, selected: true },
        { source: "intervals-ftp", watts: 215, selected: false },
        { source: "intervals-eftp", watts: 220, selected: false },
      ],
    },
    { manual: null, ftp: null, eftp: null, expected: [] },
  ])(
    "reads FTP candidates by value: $manual / $ftp / $eftp",
    async ({ manual, ftp, eftp, expected }) => {
      let refreshedAtMs = 1_000;
      const source = (watts: number | null) => (watts === null ? null : { watts, refreshedAtMs });
      const adapter = createCyclingPlanFtpAdapter({
        readManual: async () => source(manual),
        readIntervalsFtp: async () => source(ftp),
        readIntervalsEftp: async () => source(eftp),
        saveManual: async () => {},
        refreshIntervals: async () => {},
      });
      await expect(readCyclingPlanFtpCandidates(adapter)).resolves.toEqual(expected);
      refreshedAtMs = 2_000;
      await expect(readCyclingPlanFtpCandidates(adapter)).resolves.toEqual(expected);
    },
  );

  it("uses manual FTP before Intervals FTP and Intervals eFTP", async () => {
    const adapter = createCyclingPlanFtpAdapter({
      readManual: async () => value(280),
      readIntervalsFtp: async () => value(282),
      readIntervalsEftp: async () => value(289),
      saveManual: async () => {},
      refreshIntervals: async () => {},
    });
    await expect(adapter.read()).resolves.toMatchObject({
      usedSource: "manual",
      usedWatts: 280,
      conflict: true,
    });
  });

  it("falls back from Intervals FTP to Intervals eFTP", async () => {
    const adapter = createCyclingPlanFtpAdapter({
      readManual: async () => null,
      readIntervalsFtp: async () => null,
      readIntervalsEftp: async () => value(289),
      saveManual: async () => {},
      refreshIntervals: async () => {},
    });
    await expect(adapter.read()).resolves.toMatchObject({
      usedSource: "intervals-eftp",
      usedWatts: 289,
      conflict: false,
    });
  });

  it("uses Intervals FTP before Intervals eFTP", async () => {
    const adapter = createCyclingPlanFtpAdapter({
      readManual: async () => null,
      readIntervalsFtp: async () => value(282),
      readIntervalsEftp: async () => value(289),
      saveManual: async () => {},
      refreshIntervals: async () => {},
    });
    await expect(adapter.read()).resolves.toMatchObject({
      usedSource: "intervals-ftp",
      usedWatts: 282,
      conflict: true,
    });
  });

  it("saves a whole-watt manual value before resolving sources again", async () => {
    let manual: ReturnType<typeof value> | null = null;
    const saveManual = vi.fn(async (watts: number) => {
      manual = value(watts);
    });
    const adapter = createCyclingPlanFtpAdapter({
      readManual: async () => manual,
      readIntervalsFtp: async () => value(282),
      readIntervalsEftp: async () => value(289),
      saveManual,
      refreshIntervals: async () => {},
    });
    await expect(adapter.saveManual(301)).resolves.toMatchObject({
      usedSource: "manual",
      usedWatts: 301,
    });
    expect(saveManual).toHaveBeenCalledWith(301);
  });

  it("refreshes Intervals before resolving the latest source", async () => {
    let ftp: ReturnType<typeof value> | null = null;
    const adapter = createCyclingPlanFtpAdapter({
      readManual: async () => null,
      readIntervalsFtp: async () => ftp,
      readIntervalsEftp: async () => null,
      saveManual: async () => {},
      refreshIntervals: async () => {
        ftp = value(282);
      },
    });
    await expect(adapter.refreshIntervals()).resolves.toMatchObject({
      usedSource: "intervals-ftp",
      usedWatts: 282,
    });
  });

  it.each([1, 999, 1_000, 9_999])("accepts manual FTP %i", (watts) => {
    expect(validateManualPlanFtp(watts)).toBe(watts);
  });

  it.each([0, 10_000, 282.5, Number.NaN])("rejects manual FTP %s", (watts) => {
    expect(() => validateManualPlanFtp(watts)).toThrow("Enter 1–9999 whole watts.");
  });
});

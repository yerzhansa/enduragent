import { afterEach, describe, expect, it, vi } from "vitest";
import { createWallClockScheduler } from "../src/daemon/scheduler.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SIX_HOURS = 6 * HOUR;

function macWithSixHourSync(startIso: string) {
  vi.useFakeTimers({ now: Date.parse(startIso), toFake: ["setTimeout", "clearTimeout", "Date"] });
  let wallClockAheadOfTimersMs = 0;
  const nowEpochMs = () => Date.now() + wallClockAheadOfTimersMs;
  const runs: string[] = [];
  const scheduler = createWallClockScheduler({
    cadenceMs: SIX_HOURS,
    run: async () => {
      runs.push(new Date(nowEpochMs()).toISOString().slice(11, 16));
    },
    dependencies: { nowEpochMs },
  });
  return {
    runs,
    scheduler,
    sleep(ms: number) {
      wallClockAheadOfTimersMs += ms;
    },
    setWallClockBack(ms: number) {
      wallClockAheadOfTimersMs -= ms;
    },
    stayAwake(ms: number) {
      return vi.advanceTimersByTimeAsync(ms);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("six-hour sync across sleep and clock changes", () => {
  it("runs the sync missed during sleep within 5 minutes of waking", async () => {
    const mac = macWithSixHourSync("1998-09-02T05:00:00.000Z");
    mac.scheduler.start();

    mac.sleep(8 * HOUR);
    await mac.stayAwake(5 * MINUTE);
    const afterWake = [...mac.runs];
    for (let minute = 0; minute < 60 && mac.runs.length === afterWake.length; minute += 1) {
      await mac.stayAwake(MINUTE);
    }
    await mac.scheduler.close();

    expect(
      { runsWithin5MinutesOfWake: afterWake.length, firstRunAt: mac.runs[0] ?? null },
      "scheduled syncs after waking at 13:00 UTC",
    ).toEqual({ runsWithin5MinutesOfWake: 1, firstRunAt: expect.stringMatching(/^13:0[0-5]$/) });
  });

  it("runs at each six-hour mark while the Mac stays awake", async () => {
    const mac = macWithSixHourSync("1998-09-02T05:00:00.000Z");
    mac.scheduler.start();

    await mac.stayAwake(7 * HOUR + MINUTE);
    await mac.scheduler.close();

    expect(mac.runs).toEqual(["06:00", "12:00"]);
  });

  it("runs once at the mark, not early, when the wall clock is set back a second", async () => {
    const mac = macWithSixHourSync("1998-09-02T05:00:00.000Z");
    mac.scheduler.start();

    await mac.stayAwake(30 * MINUTE);
    mac.setWallClockBack(1_000);
    await mac.stayAwake(7 * HOUR);
    await mac.scheduler.close();

    expect(mac.runs).toEqual(["06:00", "12:00"]);
  });

  it("leaves no timer and runs nothing after close", async () => {
    const mac = macWithSixHourSync("1998-09-02T05:00:00.000Z");
    mac.scheduler.start();

    await mac.stayAwake(20 * MINUTE);
    await mac.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
    await mac.stayAwake(7 * HOUR);

    expect(mac.runs).toEqual([]);
  });
});

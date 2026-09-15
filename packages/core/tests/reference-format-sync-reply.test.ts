import { describe, expect, it } from "vitest";
import { formatSyncReply } from "../src/reference/sync/format-sync-reply.js";
import type { SyncResult } from "../src/reference/sync/run-sync.js";

const fixedNow = new Date("2026-05-09T14:23:32Z");

describe("formatSyncReply", () => {
  it("formats a successful sync (US-18 shape) with last sync time and refreshed list", () => {
    const r: SyncResult = {
      kind: "ran",
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Sync");
    expect(text).toContain("Last sync:");
    expect(text).toContain("Refreshed:");
    expect(text).toContain("latest");
    expect(text).toContain("history");
  });

  it("explains Strava-restricted activities with both recovery paths", () => {
    const base = {
      kind: "ran",
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest"],
    } as const;
    const clean: SyncResult = {
      ...base,
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    };
    const restricted: SyncResult = {
      ...base,
      droppedActivities: {
        overall: {
          total: 67,
          visible: 5,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
          other: 2,
        },
        recent7Days: {
          total: 5,
          visible: 1,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
          other: 0,
        },
      },
    };

    const cleanText = formatSyncReply(clean, fixedNow);
    const restrictedText = formatSyncReply(restricted, fixedNow);

    expect(cleanText).not.toContain("hidden by Strava");
    expect(restrictedText).toContain("60 of 67 activities are hidden by Strava");
    expect(restrictedText).toContain("third-party AI tools");
    expect(restrictedText).toContain("recording source directly to intervals.icu");
    expect(restrictedText).toContain("Import All Strava Data");
    expect(restrictedText).toContain("intervals.icu supporter subscription");
  });

  it("renders a no-op ran result (empty refreshed) without a dangling 'Refreshed:' line", () => {
    const r: SyncResult = {
      kind: "ran",
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: [],
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Sync");
    expect(text).toContain("Last sync:");
    expect(text).not.toContain("Refreshed:");
    expect(text.toLowerCase()).toContain("nothing changed");
  });

  it("words a future lastSyncAt honestly instead of clamping it to '0s ago'", () => {
    const r: SyncResult = {
      kind: "ran",
      lastSyncAt: new Date(fixedNow.getTime() + 10 * 60 * 1000).toISOString(),
      refreshed: ["latest"],
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).not.toContain("0s ago");
    expect(text.toLowerCase()).toMatch(/future|clock/);
  });

  it("renders a normal past lastSyncAt as 'Xs ago' (ladder unchanged)", () => {
    const r: SyncResult = {
      kind: "ran",
      lastSyncAt: "2026-05-09T14:23:00Z",
      refreshed: ["latest"],
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("32s ago");
  });

  it("formats the cooldown skip with a per-second retryAfter countdown", () => {
    const r: SyncResult = {
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 18_000,
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("Just synced");
    expect(text).toContain("18s");
  });

  it("formats the mutex_held skip as the static 'already running' reply", () => {
    const r: SyncResult = {
      kind: "skipped",
      reason: "mutex_held",
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("already running");
    expect(text.toLowerCase()).not.toContain("sync in progress");
  });

  it("formats an outer-timeout failure as 'I can't reach intervals.icu'", () => {
    const r: SyncResult = {
      kind: "failed",
      reason: "outer_timeout",
      failures: [],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("can't reach intervals.icu");
  });

  it("formats a gate_rejected failure as 'I can't reach intervals.icu' (curator may differentiate)", () => {
    const r: SyncResult = {
      kind: "failed",
      reason: "gate_rejected",
      failures: [{ file: "latest", reason: "ftp_source_check: missing FTP" }],
    };
    const text = formatSyncReply(r, fixedNow);
    expect(text.toLowerCase()).toContain("can't reach intervals.icu");
  });

  it("renders a cooldown skip without retryAfterMs as 'Just synced — please wait 0s'", () => {
    const r: SyncResult = { kind: "skipped", reason: "cooldown" };
    const text = formatSyncReply(r, fixedNow);
    expect(text).toContain("0s");
  });
});

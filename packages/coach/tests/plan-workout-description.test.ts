import { describe, expect, it, onTestFinished } from "vitest";
import { runMigrations, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { workoutContent } from "@enduragent/sport-cycling";
import { landIcuRideSettings } from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import {
  FtpUnreadableError,
  planWorkoutDescriber,
  readPlanWorkoutDescriber,
} from "../src/plan-workout-description.js";

type Kind = "hard" | "endurance" | "long" | "easy" | "event";

const GUIDANCE = "Use comfortable perceived effort or your known heart-rate guidance";

function chatRow(kind: Kind, minutes: number, extra: Record<string, unknown> = {}): string {
  const content = workoutContent(kind, minutes);
  return JSON.stringify({
    id: `draft-${kind}-${minutes}`,
    name: "Synthetic ride",
    kind,
    date: "1998-09-03",
    minutes,
    pinned: kind === "event",
    guidance: GUIDANCE,
    power: null,
    ...(content === undefined ? {} : { content }),
    ...extra,
  });
}

const withFtp = planWorkoutDescriber({ ftpKnown: true });
const withoutFtp = planWorkoutDescriber({ ftpKnown: false });

async function store(): Promise<SqlStore> {
  const opened = openSqliteStorage(":memory:");
  onTestFinished(() => opened.close());
  await runMigrations(opened, MIGRATIONS);
  return opened;
}

describe("the intervals.icu text for a Plan workout", () => {
  it.each([
    [
      "hard",
      45,
      ["Warmup", "- 10m 45-65%", "", "3x", "- 6m 88-94%", "- 3m 50%", "", "Cooldown", "- 8m 45%"],
    ],
    ["hard", 20, ["Warmup", "- 5m 45-65%", "- 11m 56-75%", "", "Cooldown", "- 4m 45%"]],
    ["endurance", 60, ["Warmup", "- 10m 45-65%", "- 40m 56-75%", "", "Cooldown", "- 10m 45%"]],
    ["long", 100, ["Warmup", "- 10m 45-65%", "- 80m 56-75%", "", "Cooldown", "- 10m 45%"]],
    ["easy", 30, ["Warmup", "- 5m 45-54%", "- 25m 45-54%"]],
    ["easy", 10, ["- 10m 45-54%"]],
  ] as const)(
    "sends a %s workout of %i minutes as its steps in %% of FTP",
    (kind, minutes, lines) => {
      expect(withFtp(chatRow(kind, minutes))).toBe(lines.join("\n"));
    },
  );

  it("sends no text for a content workout while intervals.icu has no FTP", () => {
    for (const kind of ["hard", "endurance", "long", "easy"] as const) {
      expect(withoutFtp(chatRow(kind, 45))).toBeNull();
    }
  });

  it("sends no text for an event, a workout without content, or content it cannot read", () => {
    for (const describer of [withFtp, withoutFtp]) {
      expect(describer(chatRow("event", 60))).toBeNull();
      expect(describer(chatRow("endurance", 45, { content: undefined }))).toBeNull();
      expect(describer(chatRow("endurance", 45, { content: { version: 2 } }))).toBeNull();
      expect(describer("not json")).toBeNull();
      expect(describer("[]")).toBeNull();
    }
  });

  it("keeps a stored description exactly as it is, with or without an FTP", () => {
    const legacy = JSON.stringify({
      workoutType: "sweet_spot",
      description: "Warmup\n- 10m 45-65%\n\nMain set 3x\n- 12m 88-94%\n- 3m 50%",
      workoutDoc: { steps: [] },
    });
    for (const describer of [withFtp, withoutFtp]) {
      expect(describer(legacy)).toBe(JSON.parse(legacy).description);
      expect(describer(JSON.stringify({ description: "" }))).toBe("");
      expect(describer(JSON.stringify({ description: 7 }))).toBeNull();
    }
  });

  it("never sends the workout's guidance or a watts figure", () => {
    const corrected = chatRow("hard", 45, {
      guidance: "Use your confirmed FTP of 220 W",
      power: 220,
    });
    const text = withFtp(corrected);
    expect(text).toBe(withFtp(chatRow("hard", 45)));
    for (const leaked of ["220", " W", "FTP", "Use", "guidance", "Main set"]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("reading the describer for a drain run", () => {
  it("sends the steps while intervals.icu has an FTP, and stops when the FTP is removed", async () => {
    const opened = await store();
    const row = chatRow("endurance", 60);
    const read = () => readPlanWorkoutDescriber({ store: opened, athleteId: "i1998" });
    expect((await read())(row)).toBeNull();
    await landIcuRideSettings(opened, {
      id: 77,
      ftp: 250,
      indoorFtp: null,
      updated: "1998-08-30T08:00:00.000+00:00",
    });
    expect((await read())(row)).toBe("Warmup\n- 10m 45-65%\n- 40m 56-75%\n\nCooldown\n- 10m 45%");
    await landIcuRideSettings(opened, {
      id: 77,
      ftp: null,
      indoorFtp: null,
      updated: "1998-08-31T08:00:00.000+00:00",
    });
    expect((await read())(row)).toBeNull();
  });

  it("fails when it cannot read the FTP, instead of taking it as no FTP", async () => {
    const opened = await store();
    await landIcuRideSettings(opened, {
      id: 77,
      ftp: 250,
      indoorFtp: null,
      updated: "1998-08-30T08:00:00.000+00:00",
    });
    const failing: SqlStore = {
      exec: (sql) => opened.exec(sql),
      run: (sql, params) => opened.run(sql, params),
      get: (sql, params) => opened.get(sql, params),
      all: () => Promise.reject(new Error("disk I/O error")),
      close: () => Promise.resolve(),
    };
    await expect(
      readPlanWorkoutDescriber({ store: failing, athleteId: "i1998" }),
    ).rejects.toBeInstanceOf(FtpUnreadableError);
  });
});

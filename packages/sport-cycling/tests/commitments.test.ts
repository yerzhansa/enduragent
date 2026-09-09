import { describe, expect, it } from "vitest";
import { interpretCommitments } from "../src/commitments.js";

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

describe("interpretCommitments", () => {
  it("deduplicates repeated weekday rules and retains the tightest duration", () => {
    expect(interpretCommitments(Array.from({ length: 120 }, () => "Mon off").join("\n"))).toEqual({
      rules: [{ kind: "weekday-unavailable", day: 1 }],
      status: "confirm",
      unparsed: [],
    });
    expect(
      interpretCommitments(
        "Mon 60 min. Monday 30 min. Mon 45 min. No hard on Mon. Monday easy only. Tue off",
      ).rules,
    ).toEqual([
      { kind: "weekday-duration", day: 1, minutes: 30 },
      { kind: "hard-weekday", day: 1 },
      { kind: "weekday-unavailable", day: 2 },
    ]);
  });

  it("merges overlapping time off including bridges and shared boundaries", () => {
    expect(
      interpretCommitments(
        [
          "Off 1998-09-10 to 1998-09-15",
          "Off 1998-09-01 to 1998-09-05",
          "Off 1998-09-05 to 1998-09-10",
          "Off 1998-09-02 to 1998-09-03",
          "Off 1998-09-20 to 1998-09-21",
        ].join("\n"),
      ).rules,
    ).toEqual([
      { kind: "time-off", start: "1998-09-01", end: "1998-09-15" },
      { kind: "time-off", start: "1998-09-20", end: "1998-09-21" },
    ]);
  });

  it.each(weekdays)("recognizes all spellings of %s", (weekday) => {
    for (const spelling of [
      weekday,
      weekday.slice(0, 3),
      weekday.toUpperCase(),
      `${weekday}s`,
      `${weekday.slice(0, 3)}s`,
    ]) {
      expect(interpretCommitments(`${spelling} 45 min`)).toEqual({
        rules: [{ kind: "weekday-duration", day: weekdays.indexOf(weekday) + 1, minutes: 45 }],
        unparsed: [],
        status: "confirm",
      });
    }
  });

  it.each(["", "at most ", "maximum ", "max ", "up to "])(
    "recognizes duration qualifier %s",
    (qualifier) => {
      for (const [amount, unit, minutes] of [
        [45, "min", 45],
        [45, "minutes", 45],
        [1.5, "h", 90],
        [1.5, "hours", 90],
      ]) {
        expect(interpretCommitments(`Wed ${qualifier}${amount} ${unit}`).rules).toEqual([
          { kind: "weekday-duration", day: 3, minutes },
        ]);
      }
    },
  );

  it.each(["off", "free", "unavailable", "no training", "no ride", "rest"])(
    "recognizes weekday %s",
    (form) => {
      expect(interpretCommitments(`Saturdays ${form}`).rules).toEqual([
        { kind: "weekday-unavailable", day: 6 },
      ]);
    },
  );

  it.each(["no training on Mondays", "no riding on Mon"])("recognizes %s", (text) => {
    expect(interpretCommitments(text).rules).toEqual([{ kind: "weekday-unavailable", day: 1 }]);
  });

  it.each(["no hard on Fri", "easy only on Friday", "nothing hard on Fridays", "Friday easy only"])(
    "recognizes %s",
    (text) => {
      expect(interpretCommitments(text).rules).toEqual([{ kind: "hard-weekday", day: 5 }]);
    },
  );

  it.each(["time off", "away", "holiday", "vacation", "off"])(
    "recognizes %s date ranges",
    (prefix) => {
      for (const separator of ["to", "until", "-"]) {
        for (const [start, end] of [
          ["1998-09-03", "1998-09-09"],
          ["3 September 1998", "9 Sep 1998"],
          ["3 SEP 1998", "1998-09-09"],
        ]) {
          expect(interpretCommitments(`${prefix} ${start} ${separator} ${end}`)).toEqual({
            rules: [{ kind: "time-off", start: "1998-09-03", end: "1998-09-09" }],
            unparsed: [],
            status: "confirm",
          });
        }
      }
    },
  );

  it("keeps decimal numbers intact while parsing sentences and lines", () => {
    expect(
      interpretCommitments(
        "Wed up to 1.5 hours.\nSaturday off! No hard on Mon?\nOff 3 Sep 1998 to 9 Sep 1998.",
      ),
    ).toEqual({
      rules: [
        { kind: "weekday-duration", day: 3, minutes: 90 },
        { kind: "weekday-unavailable", day: 6 },
        { kind: "hard-weekday", day: 1 },
        { kind: "time-off", start: "1998-09-03", end: "1998-09-09" },
      ],
      unparsed: [],
      status: "confirm",
    });
  });

  it.each([
    "Wednesday sometimes",
    "Away 0000-01-01 to 0000-01-02",
    "Away 0099-01-01 to 0099-01-02",
    "Wed 0 min",
    "Mon 25 hours",
    "Mon -4 min",
    "Time off 1998-02-30 to 1998-03-01",
    "Away 9 Sep 1998 to 3 Sep 1998",
    "Holiday 1 Smarch 1998 to 2 March 1998",
    "Sat off and Sun off",
    "Strength training on Wednesdays",
  ])("asks to clarify unsupported or invalid text: %s", (text) => {
    expect(interpretCommitments(text)).toEqual({ rules: [], unparsed: [text], status: "clarify" });
  });

  it("preserves unmatched fragments and does not confirm partial interpretations", () => {
    expect(interpretCommitments("Wed 45 min.\nSome busy days")).toEqual({
      rules: [{ kind: "weekday-duration", day: 3, minutes: 45 }],
      unparsed: ["Some busy days"],
      status: "clarify",
    });
    expect(interpretCommitments(" \n")).toEqual({ rules: [], unparsed: [], status: "clarify" });
  });
});

import { describe, expect, it } from "vitest";
import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { workoutPhrasebook, workoutProblem } from "../src/workout-change-sets/copy.js";
import { WorkoutChangeError } from "../src/workout-change-sets/error.js";
import {
  difference,
  renderNotice,
  renderReview,
  renderReviewDocument,
  successes,
} from "../src/workout-change-sets/review.js";
import type { Change, Notice, Payload, Snapshot } from "../src/workout-change-sets/record.js";
import { sameSnapshot, snapshot } from "../src/workout-change-sets/calendar.js";

const original: Snapshot = {
  eventId: 101,
  date: "1998-09-07",
  name: "Synthetic ride",
  durationSeconds: 3600,
  description: "Main set\n- 60m 65%",
  trainingLoad: 40,
  structure: { steps: [{ duration: 3600 }] },
};
const ride: Change = {
  kind: "add",
  id: "synthetic-add",
  recoveryIdentity: "cycling-coach:batch:synthetic-add",
  prepared: {
    kind: "add",
    sport: "cycling",
    date: "1998-09-08",
    name: "Synthetic new ride",
    durationSeconds: 3000,
    description: "Main set\n- 50m 65%",
    effort: "65% FTP",
    structure: null,
    reviewStructure: {
      name: "Synthetic new ride",
      steps: [
        {
          type: "steady",
          duration: { value: 50, unit: "minutes" },
          power: { kind: "percent_ftp", value: 65 },
        },
      ],
    },
    trainingLoad: 30,
  },
};
const edit: Change = {
  kind: "edit",
  id: "synthetic-edit",
  reviewed: original,
  desired: { ...original, durationSeconds: 4500 },
  patch: { durationSeconds: 4500 },
};
const deletion: Change = {
  kind: "delete",
  id: "synthetic-delete",
  reviewed: { ...original, eventId: 102, name: "Synthetic recovery", durationSeconds: 1800 },
};
const payload: Payload = {
  pending: [
    ride,
    {
      ...ride,
      id: "synthetic-strength",
      recoveryIdentity: "cycling-coach:batch:synthetic-strength",
      prepared: {
        ...ride.prepared,
        sport: "strength",
        name: "Synthetic strength",
        durationSeconds: 1800,
        effort: "RPE 6",
        description: "Synthetic exercises",
      },
    },
    edit,
    deletion,
  ],
  finished: [],
  context: [{ ...original, eventId: 103, durationSeconds: 2700, name: "Synthetic retained" }],
  notice: { kind: "none" },
};

describe("workout change review localization", () => {
  it("shows the complete mixed payload, both edit values, load, structure, retained context, and 155 minutes", async () => {
    const text = renderReview(payload, await workoutPhrasebook("en"));
    expect(text).toContain("2 additions, 1 edits, 1 deletions · 155 min");
    expect(text).toContain("1. Add: 1998-09-08 · Synthetic new ride · 50 min");
    expect(text).toContain("Estimated training load: 30");
    expect(text).toContain("60 min");
    expect(text).not.toContain('"steps"');
    expect(text).toContain("Current: 1998-09-07 · Synthetic ride · 60 min");
    expect(text).toContain("Proposed: 1998-09-07 · Synthetic ride · 75 min");
    expect(text).toContain("Remove this workout:");
    expect(text).toContain("Existing workouts kept:\n1998-09-07 · Synthetic retained · 45 min");
  });

  it("builds a chart card from the authored addition without duplicating serialized steps", async () => {
    const document = renderReviewDocument(
      { ...payload, pending: [ride] },
      await workoutPhrasebook("en"),
    );
    const card = document.cards[0];
    expect(card?.kind).toBe("plot");
    if (card?.kind !== "plot") throw new Error("Expected plot card");
    expect(card.chart).toMatchObject({
      title: "Synthetic new ride",
      subtitle: "1998-09-08 · 50 min",
      durationSeconds: 3000,
      segments: [{ kind: "steady", durationSeconds: 3000, target: 65 }],
    });
    const caption = card.caption.blocks.map((block) => block.text).join("\n");
    expect(caption).toContain("Add · 1 of 1 · 1998-09-08");
    expect(caption).toContain("50 min · 65% FTP");
    expect(caption).not.toContain("Main set");
    expect(caption.match(/Estimated training load/g)).toHaveLength(1);
    expect(document.summary).toContain("1 additions, 0 edits, 0 deletions");
    expect(document.summary).not.toContain("Existing workouts kept");
    expect(document.context).toContain("Existing workouts kept:\n1998-09-07 · Synthetic retained");
  });

  it("uses compact truthful text for rename-only edits and deletions", async () => {
    const rename: Change = {
      ...edit,
      desired: { ...original, name: "Synthetic renamed ride" },
      patch: { name: "Synthetic renamed ride" },
    };
    const document = renderReviewDocument(
      { ...payload, pending: [rename, deletion], context: [] },
      await workoutPhrasebook("en"),
    );
    expect(document.cards.map((card) => card.kind)).toEqual(["text", "text"]);
    const renameText =
      document.cards[0]?.kind === "text"
        ? document.cards[0].content.blocks.map((block) => block.text).join("\n")
        : "";
    const deleteText =
      document.cards[1]?.kind === "text"
        ? document.cards[1].content.blocks.map((block) => block.text).join("\n")
        : "";
    expect(renameText).toContain("name: Synthetic ride → Synthetic renamed ride");
    expect(renameText.match(/Estimated training load/g)).toHaveLength(1);
    expect(renameText).not.toContain("Main set");
    expect(renameText).toContain("↻ Edit · 1 of 2 · 1998-09-07");
    expect(deleteText).toBe("Synthetic recovery\n− Delete · 2 of 2 · 1998-09-07");
  });

  it("shows a changed estimate once and plots only the authoritative desired structure", async () => {
    const desired = {
      ...original,
      durationSeconds: 600,
      trainingLoad: 18,
      description: "Stay relaxed.",
      structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 55 } }] },
    };
    const changed: Change = {
      ...edit,
      desired,
      patch: {
        durationSeconds: 600,
        trainingLoad: 18,
        description: "Stay relaxed.",
        structure: desired.structure,
      },
    };
    const document = renderReviewDocument(
      { ...payload, pending: [changed], context: [] },
      await workoutPhrasebook("en"),
    );
    const card = document.cards[0];
    expect(card?.kind).toBe("plot");
    if (card?.kind !== "plot") throw new Error("Expected plot card");
    const text = card.caption.blocks.map((block) => block.text).join("\n");
    expect(text.match(/Estimated training load/g)).toHaveLength(1);
    expect(text).toContain("40 → 18");
    expect(text.match(/Stay relaxed\./g)).toHaveLength(1);
    expect(text).toContain("10 min · 55% FTP");
    expect(card.chart.segments).toEqual([{ kind: "steady", durationSeconds: 600, target: 55 }]);
  });

  it("plots a steps-only authored edit without repeating its old or serialized description", async () => {
    const reviewStructure = {
      steps: [
        {
          type: "steady",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    };
    const changed: Change = {
      ...edit,
      desired: {
        ...original,
        durationSeconds: 900,
        description: "Main set\n- 15m 50%",
        structure: null,
      },
      patch: { durationSeconds: 900, description: "Main set\n- 15m 50%" },
      reviewStructure,
    };
    const document = renderReviewDocument(
      { ...payload, pending: [changed], context: [] },
      await workoutPhrasebook("en"),
    );
    const card = document.cards[0];
    expect(card?.kind).toBe("plot");
    if (card?.kind !== "plot") throw new Error("Expected plot card");
    expect(card.chart).toMatchObject({
      durationSeconds: 900,
      segments: [{ kind: "steady", durationSeconds: 900, target: 50 }],
    });
    const text = card.caption.blocks.map((block) => block.text).join("\n");
    expect(text).toContain("15 min · 50% FTP");
    expect(text).not.toContain("Main set");
    expect(text).not.toContain(original.description);
  });

  it("keeps unsupported and inconsistent structures as complete text cards", async () => {
    const inconsistent: Change = {
      ...edit,
      desired: {
        ...original,
        durationSeconds: 900,
        description: "Keep the final minutes light.",
        structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 50 } }] },
      },
      patch: {
        durationSeconds: 900,
        description: "Keep the final minutes light.",
        structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 50 } }] },
      },
    };
    const document = renderReviewDocument(
      { ...payload, pending: [inconsistent], context: [] },
      await workoutPhrasebook("en"),
    );
    const card = document.cards[0];
    expect(card?.kind).toBe("text");
    if (card?.kind !== "text") throw new Error("Expected text card");
    const text = card.content.blocks.map((block) => block.text).join("\n");
    expect(text).toContain("10 min · 50% FTP");
    expect(text).toContain("Keep the final minutes light.");
  });

  it("renders provider workout targets without serializing their document or metadata", async () => {
    const structure: Snapshot["structure"] = {
      averageWatts: 125,
      steps: [
        { warmup: true, duration: 300, power: { start: 45, end: 60, units: "%ftp" } },
        {
          duration: 600,
          power: { value: 55, units: "%ftp" },
          cadence: { start: 85, end: 95, units: "rpm" },
        },
        { duration: 90, power: { value: 150, units: "w" } },
        { cooldown: true, duration: 300, power: { value: 45, units: "%ftp" } },
      ],
    };
    const text = renderReview(
      { ...payload, pending: [{ ...deletion, reviewed: { ...original, structure } }] },
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("Main set\n- 60m 65%");
    expect(text).toContain("5 min · 45 → 60% FTP");
    expect(text).toContain("10 min · 55% FTP · 85–95 rpm");
    expect(text).toContain("90 sec · 150 W");
    expect(text).not.toMatch(/averageWatts|"steps"|"units"|\{"/);
  });

  it("renders provider ramps with supplementary targets and metadata without changing their snapshots", async () => {
    const step = {
      duration: 300,
      ramp: true,
      warmup: true,
      power: { start: 40, end: 65, units: "%ftp" },
      heartrate: { value: 130, units: "bpm" },
      text: "Build gradually",
    };
    const event = {
      id: 101,
      startDateLocal: "1998-09-07T00:00:00",
      name: "Synthetic warmup",
      description: "Build gradually; keep heart rate below 130 bpm.",
      workoutDoc: { steps: [step] },
    };
    const before = snapshot(event);
    const after = snapshot({
      ...event,
      workoutDoc: { steps: [{ ...step, heartrate: { ...step.heartrate, value: 135 } }] },
    });
    const book = await workoutPhrasebook("en");
    const text = renderReview({ ...payload, pending: [{ ...deletion, reviewed: before }] }, book);
    expect(text).toContain("5 min · 40 → 65% FTP");
    expect(text).toContain(event.description);
    expect(text).not.toContain("Workout steps unavailable");
    expect(text).not.toMatch(/"ramp"|"heartrate"|"text"/);
    expect(sameSnapshot(before, after)).toBe(false);
    expect(difference(before, after, book)).toContain("Workout step details changed");
    expect(before.structure).toEqual(event.workoutDoc);
    expect(after.structure).toMatchObject({ steps: [{ heartrate: { value: 135 } }] });
  });

  it.each<Snapshot["structure"]>([
    { steps: [{ reps: 3, steps: [{ duration: 300 }] }] },
    { steps: [{ duration: 900, distance: 6000, text: "3x", reps: 3, steps: [{ duration: 300 }] }] },
  ])("renders native repeat groups with optional aggregate metadata", async (structure) => {
    const text = renderReview(
      { ...payload, pending: [{ ...deletion, reviewed: { ...original, structure } }] },
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("3 ×\n  - 5 min");
    expect(text).not.toContain("Workout steps unavailable");
    expect(text).not.toContain("15 min");
    expect(text).not.toMatch(/"reps"|"steps"|"distance"/);
  });

  it("renders nested native repetitions and their changes without expanding or mutating the document", async () => {
    const group: Snapshot["structure"] = {
      reps: 2,
      duration: 600,
      text: "2x",
      steps: [
        { duration: 120, ramp: true, power: { units: "%ftp", start: 40, end: 60 } },
        {
          reps: 3,
          steps: [
            {
              duration: 30,
              power: { units: "w", value: 200 },
              cadence: { units: "rpm", value: 90 },
            },
            { duration: 30, power: { units: "%ftp", value: 45 } },
          ],
        },
      ],
    };
    const before: Snapshot = { ...original, structure: { steps: [group] } };
    const after: Snapshot = {
      ...original,
      structure: { steps: [{ ...group, reps: 4, duration: 1200 }] },
    };
    const book = await workoutPhrasebook("en");
    const text = renderReview({ ...payload, pending: [{ ...deletion, reviewed: before }] }, book);
    expect(text).toContain(
      "2 ×\n  - 2 min · 40 → 60% FTP\n  3 ×\n    - 30 sec · 200 W · 90 rpm\n    - 30 sec · 45% FTP",
    );
    expect(text.match(/200 W/g)).toHaveLength(1);
    expect(text).not.toContain("Workout steps unavailable");
    expect(sameSnapshot(before, after)).toBe(false);
    const notice = difference(before, after, book);
    expect(notice).toContain("2 ×");
    expect(notice).toContain("4 ×");
    expect(notice).not.toMatch(/"reps"|"steps"/);
    expect(before.structure).toEqual({ steps: [group] });
  });

  it("renders authored sets, ranges, ramps, cadence and labels", async () => {
    const structure: Snapshot["structure"] = {
      name: "Synthetic intervals",
      steps: [
        {
          type: "ramp",
          duration: { value: 5, unit: "minutes" },
          power: { kind: "percent_ftp", low: 45, high: 65 },
        },
        {
          type: "set",
          repeat: 3,
          interval: {
            type: "interval",
            label: "Seated",
            duration: { value: 120, unit: "seconds" },
            power: { kind: "watts", low: 200, high: 220 },
            cadence: { low: 85, high: 95 },
          },
          recovery: {
            type: "recovery",
            duration: { value: 1, unit: "minutes" },
            power: { kind: "zone", value: 1 },
          },
        },
      ],
    };
    const text = renderReview(
      { ...payload, pending: [{ ...deletion, reviewed: { ...original, structure } }] },
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("5 min · 45 → 65% FTP");
    expect(text).toContain("3 ×");
    expect(text).toContain("2 min · 200–220 W · 85–95 rpm · Seated");
    expect(text).toContain("1 min · Zone 1");
    expect(text).not.toMatch(/"steps"|"duration"|"repeat"/);
  });

  it.each<Snapshot["structure"]>([
    { steps: [{ duration: 300, power: { units: "unknown", value: 50 } }] },
    { steps: [{ duration: 300 }, { duration: "unrecognized" }] },
    { steps: [{ reps: 0, duration: 300, steps: [{ duration: 100 }] }] },
    { steps: [{ reps: 2.5, steps: [{ duration: 100 }] }] },
    { steps: [{ reps: 3, steps: [] }] },
    { steps: [{ reps: 3, steps: [{ duration: 300, power: { units: "unknown", value: 50 } }] }] },
    { steps: [{ duration: 300, pace: { value: 4 } }] },
    { steps: [{ duration: 300, heartrate: { value: 130, units: "bpm" } }] },
    { unsupported: "private technical details" },
  ])(
    "keeps the description and marks unsupported workout documents unavailable",
    async (structure) => {
      const text = renderReview(
        { ...payload, pending: [{ ...deletion, reviewed: { ...original, structure } }] },
        await workoutPhrasebook("en"),
      );
      expect(text).toContain("Main set\n- 60m 65%");
      expect(text).toContain("Workout steps unavailable");
      expect(text).not.toMatch(/private technical details|"steps"|"duration"|"unsupported"/);
    },
  );

  it("omits absent structure for complete description-based additions", async () => {
    const text = renderReview({ ...payload, pending: [ride] }, await workoutPhrasebook("en"));
    expect(text).toContain("Main set\n- 50m 65%");
    expect(text).toContain("65% FTP");
    expect(text).not.toContain("unavailable");
  });

  it("renders changed text and workout targets without JSON quoting or escaped newlines", async () => {
    const before = {
      ...original,
      structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 50 } }] },
    };
    const after = {
      ...before,
      description: "New instructions\nStay seated",
      name: "Revised ride",
      trainingLoad: null,
      structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 55 } }] },
    };
    const text = difference(before, after, await workoutPhrasebook("en"));
    expect(text).toContain("Synthetic ride → Revised ride");
    expect(text).toContain("New instructions\nStay seated");
    expect(text).toContain("50% FTP");
    expect(text).toContain("55% FTP");
    expect(text).toContain("40 → unavailable");
    expect(text).not.toMatch(/\\n|"steps"|"duration"|"Revised ride"|\bnull\b/);
  });

  it("retains exact change detection when workout documents have the same readable steps", async () => {
    const event = {
      id: 101,
      startDateLocal: "1998-09-07T00:00:00",
      name: "Synthetic ride",
      workoutDoc: {
        averageWatts: 125,
        steps: [{ duration: 600, power: { units: "%ftp", value: 50 } }],
      },
    };
    const before = snapshot(event);
    const after = snapshot({ ...event, workoutDoc: { ...event.workoutDoc, averageWatts: 130 } });
    expect(sameSnapshot(before, after)).toBe(false);
    const text = renderNotice(
      { kind: "changed", differences: [{ before, after }], additional: false },
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("Workout step details changed");
    expect(text).toContain("No changes were applied");
    expect(text).not.toContain("averageWatts");
    expect(before.structure).toMatchObject({ averageWatts: 125 });
    expect(after.structure).toMatchObject({ averageWatts: 130 });
  });

  it("localizes fractional targets and unsupported structure notices", async () => {
    const book = await workoutPhrasebook("de-DE");
    const structure = {
      steps: [
        {
          duration: 30,
          power: { units: "watts", value: 145.5 },
          cadence: { units: "rpm", value: 90 },
        },
      ],
    };
    const text = renderReview(
      { ...payload, pending: [{ ...deletion, reviewed: { ...original, structure } }] },
      book,
    );
    expect(text).toContain("145,5 W · 90 rpm");
    const notice = difference(original, { ...original, structure: { unsupported: true } }, book);
    expect(notice).toContain("Trainingsabschnitte nicht verfügbar");
    expect(notice).not.toMatch(/unsupported|unavailable|"steps"/);
  });

  it("renders persisted difference evidence in the current language instead of saving English text", async () => {
    const notice: Notice = {
      kind: "changed",
      differences: [
        { before: original, after: { ...original, durationSeconds: 5400, trainingLoad: 60 } },
      ],
      additional: true,
    };
    const english = renderNotice(notice, await workoutPhrasebook("en"));
    const spanish = renderNotice(notice, await workoutPhrasebook("es"));
    expect(english).toContain("duration: 60 min → 90 min");
    expect(english).toContain("training load: 40 → 60");
    expect(spanish).toContain("cambió en intervals.icu");
    expect(spanish).toContain("duración: 60 min → 90 min");
    expect(spanish).toContain("No se aplicó ningún cambio adicional.");
    expect(spanish).not.toContain("No additional");
  });

  it("keeps observed desired state distinct from a confirmed write", async () => {
    const text = successes(
      [
        { kind: "confirmed-write", change: ride, eventId: 104 },
        { kind: "observed-desired-state", change: edit, eventId: 101 },
      ],
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("Synthetic new ride (confirmed)");
    expect(text).toContain("Synthetic ride (desired state observed; response not received)");
  });

  it("does not present a missing delete target as confirmed coach deletion", async () => {
    const text = renderNotice(
      { kind: "recoveredDeleteAbsent", change: deletion },
      await workoutPhrasebook("en"),
    );
    expect(text).toContain("Synthetic recovery");
    expect(text).toContain("not a confirmed coach deletion");
    expect(text).toContain("Retry remains disabled");
  });

  it("keeps unknown values honest and formats fractional minutes with the selected locale", async () => {
    const unknown = {
      ...original,
      name: null,
      durationSeconds: null,
      description: null,
      structure: null,
      trainingLoad: null,
    };
    const book = await workoutPhrasebook("de-DE");
    expect(difference(original, { ...original, durationSeconds: 3630 }, book)).toContain(
      "60,5 Min.",
    );
    const text = renderReview(
      { ...payload, pending: [{ ...edit, desired: unknown }], context: [] },
      book,
    );
    expect(text).toContain("Dauer nicht verfügbar");
    expect(text).toContain("Gesamtdauer nicht verfügbar");
    expect(text).toContain("Beschreibung nicht verfügbar");
  });

  it("localizes known guards and hides unknown raw error details", async () => {
    const book = await workoutPhrasebook("fr");
    for (const message of ["Past workout dates are protected.", "This date precedes today."]) {
      expect(workoutProblem(new WorkoutChangeError("pastProtected", message), book)).toBe(
        "Les entraînements passés sont protégés.",
      );
    }
    expect(workoutProblem(new Error("private diagnostic content"), book)).toBe(
      "Le calendrier n’a pas pu être vérifié.",
    );
  });

  it("does not accept a plain error impersonating a domain reason", async () => {
    const book = await workoutPhrasebook("fr");
    const lookalike = Object.assign(new Error("Past workout dates are protected."), {
      name: "WorkoutChangeError",
      reason: "pastProtected",
    });
    expect(workoutProblem(lookalike, book)).toBe("Le calendrier n’a pas pu être vérifié.");
  });

  it.each(LANGUAGE_OPTIONS)("loads complete review and control copy for $tag", async ({ tag }) => {
    const book = await workoutPhrasebook(tag);
    const text = renderReview(payload, book);
    expect(text).toContain("Synthetic new ride");
    expect(text).not.toContain("workouts.");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("[object Object]");
    if (tag !== "en") expect(text).not.toContain("Review all workout changes");
    const command = book.say("workouts.approval.terminalPrompt", {
      action: "retry",
      cancel: "cancel",
    });
    expect(command).toContain("retry");
    expect(command).toContain("cancel");
    expect(command).not.toContain("{{");
    expect(book.say("workouts.approval.retryRemaining")).not.toContain("workouts.");
  });
});

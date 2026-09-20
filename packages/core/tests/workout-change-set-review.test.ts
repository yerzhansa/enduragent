import { describe, expect, it } from "vitest";
import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { workoutPhrasebook, workoutProblem } from "../src/workout-change-sets/copy.js";
import { WorkoutChangeError } from "../src/workout-change-sets/error.js";
import {
  difference,
  renderNotice,
  renderReview,
  successes,
} from "../src/workout-change-sets/review.js";
import type { Change, Notice, Payload, Snapshot } from "../src/workout-change-sets/record.js";

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
    expect(text).toContain("Training load: 30");
    expect(text).toContain('Effort structure: {"steps":[{"duration":3600}]}');
    expect(text).toContain("Current: 1998-09-07 · Synthetic ride · 60 min");
    expect(text).toContain("Proposed: 1998-09-07 · Synthetic ride · 75 min");
    expect(text).toContain("Remove this workout:");
    expect(text).toContain("Existing workouts kept:\n1998-09-07 · Synthetic retained · 45 min");
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

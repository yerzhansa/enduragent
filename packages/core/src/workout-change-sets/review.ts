import type { CatalogKey } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { Change, Notice, Payload, Receipt, Snapshot } from "./record.js";
import { readableEffort, workoutEffortPlot } from "./effort.js";
import type {
  WorkoutCardBlock,
  WorkoutChartModel,
  WorkoutChartSegment,
  WorkoutChartUnit,
  WorkoutReviewDocument,
} from "./presentation.js";

function minutes(value: number | null, book: Phrasebook): string {
  return value === null
    ? book.say("workouts.review.durationUnavailable")
    : book.say("workouts.review.minutes", {
        minutes: book.format.number(value / 60, { maximumFractionDigits: 2 }),
      });
}

function details(value: Omit<Snapshot, "eventId">, book: Phrasebook): string {
  return book
    .say("workouts.review.details", {
      date: value.date,
      name: value.name ?? book.say("coach.proposal.unnamed"),
      duration: minutes(value.durationSeconds, book),
      description: value.description ?? book.say("workouts.review.descriptionUnavailable"),
      load:
        value.trainingLoad === null
          ? book.say("workouts.review.unavailable")
          : book.format.number(value.trainingLoad),
      structure:
        value.structure === null
          ? ""
          : book.say("workouts.review.structureDetails", {
              steps: readableEffort(value.structure, book),
            }),
    })
    .trimEnd();
}

function estimate(value: number | null, book: Phrasebook): string {
  const displayed =
    value === null ? book.say("workouts.review.unavailable") : book.format.number(value);
  return book.say("workouts.review.estimatedLoad", { load: displayed });
}

function plotUnit(unit: WorkoutChartUnit, book: Phrasebook): string {
  if (unit === "percent_ftp") return "% FTP";
  if (unit === "watts") return "W";
  return book.say("training.ride.zone");
}

function chart(input: {
  readonly name: string;
  readonly date: string;
  readonly durationSeconds: number;
  readonly unit: WorkoutChartUnit;
  readonly segments: readonly WorkoutChartSegment[];
  readonly book: Phrasebook;
}): WorkoutChartModel {
  const duration = minutes(input.durationSeconds, input.book);
  const unit = plotUnit(input.unit, input.book);
  return {
    title: input.name,
    subtitle: `${input.date} · ${duration}`,
    axisLabel: `${input.book.say("workouts.review.field.effort")} · ${unit}`,
    startLabel: input.book.format.number(0),
    endLabel: duration,
    unit: input.unit,
    durationSeconds: input.durationSeconds,
    segments: input.segments,
  };
}

function descriptionBlocks(description: string | null, book: Phrasebook): WorkoutCardBlock[] {
  if (description === null) return [];
  return [
    { kind: "heading", text: book.say("workouts.review.field.description") },
    { kind: "text", text: description },
  ];
}

export function reviewCounts(payload: Payload, book: Phrasebook): string {
  const adds = payload.pending.filter((change) => change.kind === "add").length;
  const edits = payload.pending.filter((change) => change.kind === "edit").length;
  const deletions = payload.pending.filter((change) => change.kind === "delete").length;
  const durations = payload.pending.flatMap((change) =>
    change.kind === "add"
      ? [change.prepared.durationSeconds]
      : change.kind === "edit"
        ? [change.desired.durationSeconds]
        : [],
  );
  const duration = durations.some((value) => value === null)
    ? book.say("workouts.review.totalUnavailable")
    : minutes(
        durations.reduce<number>((sum, value) => sum + (value ?? 0), 0),
        book,
      );
  return book.say("workouts.review.summary", {
    adds: book.format.number(adds),
    edits: book.format.number(edits),
    deletions: book.format.number(deletions),
    duration,
  });
}

function reviewContext(payload: Payload, book: Phrasebook): string {
  if (payload.context.length === 0) return "";
  return `${book.say("workouts.review.kept")}\n${payload.context.map((value) => `${value.date} · ${value.name ?? book.say("coach.proposal.unnamed")} · ${minutes(value.durationSeconds, book)}`).join("\n")}`;
}

export function reviewSummary(payload: Payload, book: Phrasebook): string {
  const context = reviewContext(payload, book);
  return `${reviewCounts(payload, book)}${context === "" ? "" : `\n\n${context}`}`;
}

export function changeLabel(change: Change, book: Phrasebook): string {
  return change.kind === "add"
    ? `${change.prepared.date} · ${change.prepared.name}`
    : `${change.reviewed.date} · ${change.reviewed.name ?? book.say("coach.proposal.unnamed")}`;
}

export function successes(receipts: readonly Receipt[], book: Phrasebook): string {
  if (receipts.length === 0) return "";
  const lines = receipts.map((receipt) => {
    const status = book.say(
      receipt.kind === "confirmed-write" ? "workouts.review.confirmed" : "workouts.review.observed",
    );
    return `${changeLabel(receipt.change, book)} (${status})`;
  });
  return `${book.say("workouts.review.alreadyCompleted")}\n${lines.join("\n")}\n\n`;
}

export function renderReview(payload: Payload, book: Phrasebook): string {
  const lines = payload.pending.map((change, index) => {
    const position = book.format.number(index + 1);
    if (change.kind === "add")
      return book.say("workouts.review.add", {
        index: position,
        details: details(change.prepared, book),
        effort: change.prepared.effort,
      });
    if (change.kind === "delete")
      return book.say("workouts.review.remove", {
        index: position,
        details: details(change.reviewed, book),
      });
    return book.say("workouts.review.edit", {
      index: position,
      current: details(change.reviewed, book),
      proposed: details(change.desired, book),
    });
  });
  const summary = reviewSummary(payload, book);
  const notice = renderNotice(payload.notice, book);
  return `${notice ? `${notice}\n\n` : ""}${successes(payload.finished, book)}${book.say("workouts.review.title")}\n\n${lines.join("\n\n")}\n\n${summary}`;
}

function cardChangedFields(
  before: Omit<Snapshot, "eventId">,
  after: Omit<Snapshot, "eventId">,
  book: Phrasebook,
): string[] {
  const changed = fields.flatMap(({ field, key }) => {
    const previous = before[field];
    const current = after[field];
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    if (field === "trainingLoad") {
      const oldValue =
        before.trainingLoad === null
          ? book.say("workouts.review.unavailable")
          : book.format.number(before.trainingLoad);
      const newValue =
        after.trainingLoad === null
          ? book.say("workouts.review.unavailable")
          : book.format.number(after.trainingLoad);
      return [book.say("workouts.review.estimatedLoad", { load: `${oldValue} → ${newValue}` })];
    }
    if (field === "structure") return [book.say("workouts.review.structureChanged")];
    if (field === "description")
      return [book.say("workouts.review.fieldChanged", { field: book.say(key) })];
    const oldValue = fieldValue(before, field, book);
    const newValue = fieldValue(after, field, book);
    return [`${book.say(key)}: ${oldValue} → ${newValue}`];
  });
  return changed;
}

function isCompactEdit(change: Extract<Change, { kind: "edit" }>): boolean {
  return Object.entries(change.patch)
    .filter(([, value]) => value !== undefined)
    .every(([field]) => field === "name" || field === "date");
}

function contentForChange(
  change: Change,
  index: number,
  total: number,
  book: Phrasebook,
): WorkoutReviewDocument["cards"][number] {
  const position = book.say("workouts.review.position", {
    current: book.format.number(index + 1),
    total: book.format.number(total),
  });
  if (change.kind === "delete")
    return {
      kind: "text",
      content: {
        blocks: [
          { kind: "heading", text: change.reviewed.name ?? book.say("coach.proposal.unnamed") },
          {
            kind: "text",
            text: `− ${book.say("workouts.review.action.delete")} · ${position} · ${change.reviewed.date}`,
          },
        ],
      },
    };

  if (change.kind === "add") {
    const value = change.prepared;
    const plot =
      value.sport === "cycling"
        ? workoutEffortPlot({
            structure: value.reviewStructure ?? value.structure,
            durationSeconds: value.durationSeconds,
          })
        : null;
    const blocks: WorkoutCardBlock[] = [
      { kind: "heading", text: value.name },
      {
        kind: "text",
        text: `+ ${book.say("workouts.review.action.add")} · ${position} · ${value.date} · ${minutes(value.durationSeconds, book)}`,
      },
    ];
    if (plot === null) {
      blocks.push({ kind: "heading", text: book.say("workouts.review.field.effort") });
      blocks.push({ kind: "text", text: value.effort });
      blocks.push({ kind: "heading", text: book.say("workouts.review.field.description") });
      blocks.push({ kind: "text", text: value.description });
    } else {
      blocks.push({ kind: "heading", text: book.say("workouts.review.field.effort") });
      blocks.push({
        kind: "text",
        text: readableEffort(value.reviewStructure ?? value.structure, book),
      });
      if (value.reviewStructure === undefined) {
        blocks.push({ kind: "heading", text: book.say("workouts.review.field.description") });
        blocks.push({ kind: "text", text: value.description });
      }
    }
    blocks.push({ kind: "heading", text: estimate(value.trainingLoad, book) });
    if (plot === null) return { kind: "text", content: { blocks } };
    return {
      kind: "plot",
      chart: chart({
        name: value.name,
        date: value.date,
        durationSeconds: value.durationSeconds,
        unit: plot.unit,
        segments: plot.segments,
        book,
      }),
      caption: { blocks },
    };
  }

  const name = change.desired.name ?? book.say("coach.proposal.unnamed");
  const changes = cardChangedFields(change.reviewed, change.desired, book);
  const blocks: WorkoutCardBlock[] = [
    { kind: "heading", text: name },
    {
      kind: "text",
      text: `↻ ${book.say("workouts.review.action.edit")} · ${position} · ${change.desired.date} · ${minutes(change.desired.durationSeconds, book)}`,
    },
    { kind: "text", text: changes.join("\n") },
  ];
  if (change.reviewed.trainingLoad === change.desired.trainingLoad)
    blocks.push({ kind: "heading", text: estimate(change.desired.trainingLoad, book) });
  if (isCompactEdit(change)) return { kind: "text", content: { blocks } };

  const reviewStructure = change.reviewStructure ?? change.desired.structure;
  const plot = workoutEffortPlot({
    structure: reviewStructure,
    durationSeconds: change.desired.durationSeconds,
  });
  const durationSeconds = change.desired.durationSeconds;
  if (plot === null || durationSeconds === null) {
    if (reviewStructure !== null) {
      blocks.push({ kind: "heading", text: book.say("workouts.review.field.effort") });
      blocks.push({ kind: "text", text: readableEffort(reviewStructure, book) });
    }
    blocks.push(...descriptionBlocks(change.desired.description, book));
    return { kind: "text", content: { blocks } };
  }
  blocks.push({ kind: "heading", text: book.say("workouts.review.field.effort") });
  blocks.push({ kind: "text", text: readableEffort(reviewStructure, book) });
  if (change.reviewStructure === undefined)
    blocks.push(...descriptionBlocks(change.desired.description, book));
  return {
    kind: "plot",
    chart: chart({
      name,
      date: change.desired.date,
      durationSeconds,
      unit: plot.unit,
      segments: plot.segments,
      book,
    }),
    caption: { blocks },
  };
}

export function renderReviewDocument(payload: Payload, book: Phrasebook): WorkoutReviewDocument {
  const notice = renderNotice(payload.notice, book);
  return {
    introduction: `${notice ? `${notice}\n\n` : ""}${successes(payload.finished, book)}${book.say("workouts.review.title")}`,
    cards: payload.pending.map((change, index) =>
      contentForChange(change, index, payload.pending.length, book),
    ),
    context: reviewContext(payload, book),
    summary: reviewCounts(payload, book),
  };
}

const fields: readonly { field: Exclude<keyof Snapshot, "eventId">; key: CatalogKey }[] = [
  { field: "date", key: "workouts.review.field.date" },
  { field: "name", key: "workouts.review.field.name" },
  { field: "durationSeconds", key: "workouts.review.field.duration" },
  { field: "description", key: "workouts.review.field.description" },
  { field: "trainingLoad", key: "workouts.review.field.trainingLoad" },
  { field: "structure", key: "workouts.review.field.structure" },
];

export function difference(before: Snapshot, after: Snapshot, book: Phrasebook): string {
  return book.say("workouts.review.changed", {
    name: before.name ?? book.say("coach.proposal.unnamed"),
    changes: changedFields(before, after, book).join("; "),
  });
}

function changedFields(
  before: Omit<Snapshot, "eventId">,
  after: Omit<Snapshot, "eventId">,
  book: Phrasebook,
): string[] {
  const changes = fields.flatMap(({ field, key }) => {
    const previous = before[field];
    const current = after[field];
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    const oldValue = fieldValue(before, field, book);
    const newValue = fieldValue(after, field, book);
    if (field === "structure" && oldValue === newValue)
      return [book.say("workouts.review.structureChanged")];
    return [`${book.say(key)}: ${oldValue} → ${newValue}`];
  });
  return changes;
}

function fieldValue(
  value: Omit<Snapshot, "eventId">,
  field: Exclude<keyof Snapshot, "eventId">,
  book: Phrasebook,
): string {
  switch (field) {
    case "date":
      return value.date;
    case "name":
      return value.name ?? book.say("coach.proposal.unnamed");
    case "durationSeconds":
      return minutes(value.durationSeconds, book);
    case "description":
      return value.description ?? book.say("workouts.review.descriptionUnavailable");
    case "trainingLoad":
      return value.trainingLoad === null
        ? book.say("workouts.review.unavailable")
        : book.format.number(value.trainingLoad);
    case "structure":
      return readableEffort(value.structure, book);
  }
}

export function renderNotice(notice: Notice, book: Phrasebook): string {
  switch (notice.kind) {
    case "none":
      return "";
    case "proposedRevision":
      return book.say("workouts.review.proposedRevision", {
        changes: notice.differences
          .map(({ before, after }) => {
            const previous =
              before.kind === "add"
                ? before.prepared
                : before.kind === "edit"
                  ? before.desired
                  : before.reviewed;
            const next =
              after.kind === "add"
                ? after.prepared
                : after.kind === "edit"
                  ? after.desired
                  : after.reviewed;
            const changes = changedFields(previous, next, book);
            if (
              before.kind === "add" &&
              after.kind === "add" &&
              before.prepared.effort !== after.prepared.effort
            )
              changes.push(
                `${book.say("workouts.review.field.effort")}: ${before.prepared.effort} → ${after.prepared.effort}`,
              );
            return book.say("workouts.review.revised", {
              name: changeLabel(before, book),
              changes: changes.join("; "),
            });
          })
          .join("\n"),
      });
    case "changed":
      return `${notice.differences.map(({ before, after }) => difference(before, after, book)).join("\n")}\n${book.say(notice.additional ? "workouts.outcome.noAdditional" : "workouts.outcome.noChanges")}`;
    case "rejected":
      return book.say("workouts.outcome.rejected", { label: changeLabel(notice.change, book) });
    case "uncertain":
      return book.say("workouts.outcome.uncertain", { label: changeLabel(notice.change, book) });
    case "recoveredStopped":
      return book.say("workouts.outcome.recoveredStopped");
    case "recoveredUncertain":
      return book.say("workouts.outcome.recoveredUncertain");
    case "recoveredObserved":
      return book.say("workouts.outcome.recoveredObserved");
    case "recoveredDeleteAbsent":
      return book.say("workouts.outcome.recoveredDeleteAbsent", {
        label: changeLabel(notice.change, book),
      });
    case "blocked":
      return book.say(`workouts.outcome.${notice.reason}`);
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

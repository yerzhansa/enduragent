import type { CatalogKey } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { Change, Notice, Payload, Receipt, Snapshot } from "./record.js";

function minutes(value: number | null, book: Phrasebook): string {
  return value === null
    ? book.say("workouts.review.durationUnavailable")
    : book.say("workouts.review.minutes", {
        minutes: book.format.number(value / 60, { maximumFractionDigits: 2 }),
      });
}

function details(value: Omit<Snapshot, "eventId">, book: Phrasebook): string {
  return book.say("workouts.review.details", {
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
        ? book.say("workouts.review.unavailable")
        : JSON.stringify(value.structure),
  });
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
  const context =
    payload.context.length === 0
      ? ""
      : `\n\n${book.say("workouts.review.kept")}\n${payload.context.map((value) => `${value.date} · ${value.name ?? book.say("coach.proposal.unnamed")} · ${minutes(value.durationSeconds, book)}`).join("\n")}`;
  const summary = book.say("workouts.review.summary", {
    adds: book.format.number(adds),
    edits: book.format.number(edits),
    deletions: book.format.number(deletions),
    duration,
  });
  const notice = renderNotice(payload.notice, book);
  return `${notice ? `${notice}\n\n` : ""}${successes(payload.finished, book)}${book.say("workouts.review.title")}\n\n${lines.join("\n\n")}\n\n${summary}${context}`;
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
  const changes = fields.flatMap(({ field, key }) => {
    const previous = before[field];
    const current = after[field];
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    const oldValue =
      field === "durationSeconds"
        ? minutes(before.durationSeconds, book)
        : JSON.stringify(previous);
    const newValue =
      field === "durationSeconds" ? minutes(after.durationSeconds, book) : JSON.stringify(current);
    return [`${book.say(key)}: ${oldValue} → ${newValue}`];
  });
  return book.say("workouts.review.changed", {
    name: before.name ?? book.say("coach.proposal.unnamed"),
    changes: changes.join("; "),
  });
}

export function renderNotice(notice: Notice, book: Phrasebook): string {
  switch (notice.kind) {
    case "none":
      return "";
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

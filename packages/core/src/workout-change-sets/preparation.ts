import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PreparedChange } from "@enduragent/engine";
import { COACH_EXTERNAL_ID_PREFIX } from "@enduragent/engine/sport";
import {
  creationInput,
  desired,
  eligible,
  readEvent,
  snapshot,
  updateInput,
  type CalendarClient,
} from "./calendar.js";
import { WorkoutChangeError } from "./error.js";
import type { Change, CheckedPreparation, Notice } from "./record.js";

type PreparedItem = Extract<CheckedPreparation, { kind: "complete" }>["changes"][number];

function withRetainedChart(
  before: Extract<Change, { kind: "edit" }>,
  next: Extract<PreparedItem, { kind: "edit" }>,
): Extract<PreparedItem, { kind: "edit" }> {
  const patch = {
    ...before.patch,
    ...Object.fromEntries(Object.entries(next.patch).filter(([, value]) => value !== undefined)),
  };
  if (next.reviewStructure !== undefined) delete patch.structure;
  const candidate = desired({ ...before, patch }, before.reviewed);
  const replacesContent = !isDeepStrictEqual(
    {
      durationSeconds: candidate.durationSeconds,
      description: candidate.description,
      structure: candidate.structure,
    },
    {
      durationSeconds: before.desired.durationSeconds,
      description: before.desired.description,
      structure: before.desired.structure,
    },
  );
  const reviewStructure =
    next.reviewStructure !== undefined
      ? next.reviewStructure
      : replacesContent
        ? undefined
        : before.reviewStructure;
  return {
    ...next,
    patch,
    ...(reviewStructure === undefined ? {} : { reviewStructure }),
  };
}

function preparedChange(change: Change): PreparedChange {
  switch (change.kind) {
    case "add":
      return change.prepared;
    case "edit":
      return {
        kind: "edit",
        eventId: change.reviewed.eventId,
        patch: change.patch,
        ...(change.reviewStructure === undefined
          ? {}
          : { reviewStructure: change.reviewStructure }),
      };
    case "delete":
      return { kind: "delete", eventId: change.reviewed.eventId };
  }
}

export async function preparePending(input: {
  readonly preparation: Exclude<CheckedPreparation, { kind: "incomplete" }>;
  readonly previous: readonly Change[];
  readonly client: CalendarClient;
  readonly today: string;
}): Promise<{ pending: Change[]; notice: Notice }> {
  function future(date: string): void {
    if (date < input.today)
      throw new WorkoutChangeError("pastProtected", "Past workout dates are protected.");
  }
  async function build(
    item: Extract<CheckedPreparation, { kind: "complete" }>["changes"][number],
    previous?: Change,
  ): Promise<Change> {
    const id = previous?.id ?? randomUUID();
    if (item.kind === "add") {
      future(item.date);
      const change: Change = {
        kind: "add",
        id,
        prepared: item,
        recoveryIdentity:
          previous?.kind === "add"
            ? previous.recoveryIdentity
            : `${COACH_EXTERNAL_ID_PREFIX}batch:${id}`,
      };
      creationInput(change);
      return change;
    }
    const event = await readEvent(input.client, item.eventId);
    eligible(event, input.today);
    const reviewed = snapshot(event);
    if (item.kind === "delete") return { kind: "delete", id, reviewed };
    const change: Change = {
      kind: "edit",
      id,
      reviewed,
      desired: reviewed,
      patch: item.patch,
      ...(item.reviewStructure === undefined ? {} : { reviewStructure: item.reviewStructure }),
    };
    change.desired = desired(change, reviewed);
    future(change.desired.date);
    updateInput(change);
    return change;
  }
  const preparation = input.preparation;
  let pending: Change[];
  let notice: Notice = { kind: "none" };
  if (preparation.kind === "revise") {
    const originals = new Map(input.previous.map((change) => [change.id, change]));
    const replacements = new Map<string, Change>();
    const differences: { before: Change; after: Change }[] = [];
    for (const replacement of preparation.replacements) {
      const before = originals.get(replacement.id);
      if (before === undefined || replacements.has(replacement.id))
        throw new Error(
          "Each revision must identify one distinct pending workout from the current proposal.",
        );
      const next = replacement.change;
      if (
        before.kind !== next.kind ||
        (before.kind === "add" && next.kind === "add" && before.prepared.sport !== next.sport) ||
        (before.kind !== "add" && next.kind !== "add" && before.reviewed.eventId !== next.eventId)
      )
        throw new Error(
          "A targeted revision must keep its action and calendar workout. Use explicit whole-set replacement to change them.",
        );
      const effective =
        before.kind === "edit" && next.kind === "edit" ? withRetainedChart(before, next) : next;
      if (isDeepStrictEqual(preparedChange(before), effective))
        throw new Error("Each selected workout must contain an actual change.");
      const after = await build(effective, before);
      if (
        before.kind === "edit" &&
        after.kind === "edit" &&
        isDeepStrictEqual(before.desired, after.desired) &&
        isDeepStrictEqual(before.reviewStructure, after.reviewStructure)
      )
        throw new Error("Each selected workout must contain an actual change.");
      replacements.set(before.id, after);
      differences.push({ before, after });
    }
    pending = input.previous.map((change) => replacements.get(change.id) ?? change);
    notice = { kind: "proposedRevision", differences };
  } else {
    pending = [];
    for (const item of preparation.changes) pending.push(await build(item));
  }
  const targets = new Set<number>();
  for (const change of pending) {
    if (change.kind === "add") continue;
    if (targets.has(change.reviewed.eventId))
      throw new Error("A workout cannot have multiple actions in one review.");
    targets.add(change.reviewed.eventId);
  }
  return { pending, notice };
}

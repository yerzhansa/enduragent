import {
  PlanChangeEventSourceSchema,
  type ListPlansResult,
  type PlanChangeModel,
  type SupportingEvent,
} from "@enduragent/coach-contract";

type EventDifference = { before: SupportingEvent[]; after: SupportingEvent[] };

function eventSource(change: PlanChangeModel) {
  const parsed = PlanChangeEventSourceSchema.safeParse(
    change.premises.find((premise) => premise.id === "event-source")?.value,
  );
  return parsed.success ? parsed.data : null;
}

function applyEventChange(
  before: SupportingEvent[],
  change: PlanChangeModel,
  history: Map<string, EventDifference>,
): SupportingEvent[] {
  const intent = change.intent;
  if (intent.kind === "inverse") {
    const original = history.get(intent.changeId);
    if (!original) return before;
    const removed = new Set(
      change.diff.flatMap((row) =>
        row.before?.supportingEventId && !row.after ? [row.before.supportingEventId] : [],
      ),
    );
    const restored = new Set(
      change.diff.flatMap((row) =>
        row.after?.supportingEventId ? [row.after.supportingEventId] : [],
      ),
    );
    return [
      ...original.before.filter(
        (event) => before.some((current) => current.id === event.id) || restored.has(event.id),
      ),
      ...before.filter(
        (event) =>
          !original.before.some((previous) => previous.id === event.id) && !removed.has(event.id),
      ),
    ].map((event) => {
      const current = before.find((item) => item.id === event.id);
      return current && current.date !== event.date && !restored.has(event.id) ? current : event;
    });
  }
  if (intent.kind !== "supporting-event") return before;
  const source = eventSource(change);
  if (intent.operation === "add") {
    const workout = change.diff.find((row) => row.after?.supportingEventId)?.after;
    if (!workout?.supportingEventId || !workout.date) return before;
    if (intent.providerId !== undefined && !source) return before;
    return [
      ...before,
      {
        id: workout.supportingEventId,
        name: workout.name,
        date: workout.date,
        role: intent.role,
        source:
          intent.providerId !== undefined && source
            ? {
                kind: "synced",
                providerId: source.providerId,
                sourceRevision: source.sourceRevision,
              }
            : { kind: "manual" },
      },
    ];
  }
  if (intent.operation === "remove") return before.filter((event) => event.id !== intent.eventId);
  return before.map((event) => {
    if (event.id !== intent.eventId) return event;
    switch (intent.operation) {
      case "role":
        return { ...event, role: intent.role };
      case "name":
        return { ...event, name: intent.name };
      case "manual":
        return { ...event, name: intent.name, date: intent.date };
      case "source-update":
        return source
          ? {
              ...event,
              name: source.name,
              date: source.date,
              source: {
                kind: "synced",
                providerId: source.providerId,
                sourceRevision: source.sourceRevision,
              },
            }
          : event;
    }
  });
}

function eventHistory(library: ListPlansResult, planId: string) {
  const history = new Map<string, EventDifference>();
  let current: SupportingEvent[] = [];
  for (const change of library.changes
    .filter((item) => item.planId === planId && item.status === "applied")
    .sort((left, right) => (left.resultRevisionNumber ?? 0) - (right.resultRevisionNumber ?? 0))) {
    const after = applyEventChange(current, change, history);
    history.set(change.changeId, { before: current, after });
    current = after;
  }
  return { current, history };
}

export function currentSupportingEvents(library: ListPlansResult): SupportingEvent[] {
  return library.active ? eventHistory(library, library.active.planId).current : [];
}

export function supportingEventDifference(
  library: ListPlansResult,
  change: PlanChangeModel,
): EventDifference {
  const { current, history } = eventHistory(library, change.planId);
  const accepted = history.get(change.changeId);
  if (accepted) return accepted;
  const preceding = library.changes
    .filter(
      (item) =>
        item.planId === change.planId &&
        item.status === "applied" &&
        item.resultRevisionNumber !== null &&
        item.resultRevisionNumber <= change.baseRevisionNumber,
    )
    .sort((left, right) => (right.resultRevisionNumber ?? 0) - (left.resultRevisionNumber ?? 0))[0];
  const before = preceding ? (history.get(preceding.changeId)?.after ?? current) : [];
  return { before, after: applyEventChange(before, change, history) };
}

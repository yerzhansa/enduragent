import type { CoachDecisionReadModel, PlanChangeModel } from "@enduragent/coach-contract";

export type ConversationProjection =
  | { readonly kind: "planning-request"; readonly id: string }
  | { readonly kind: "plan-creation"; readonly id: string }
  | { readonly kind: "coach-decision"; readonly id: string }
  | { readonly kind: "coach-decision-availability" }
  | { readonly kind: "plan-creation-dock"; readonly id: string }
  | { readonly kind: "plan-change-current"; readonly id: string }
  | { readonly kind: "plan-change"; readonly id: string }
  | { readonly kind: "plan-change-check"; readonly id: string }
  | { readonly kind: "coach-progress" };

export interface PendingNavigation {
  readonly key: `plan-creation:${string}` | `plan-change:${string}` | `coach-decision:${string}`;
  readonly kind: "plan-creation" | "plan-change" | "coach-decision";
}

export interface ConversationRow<Value> {
  readonly key: string;
  readonly value: Value;
  readonly occurredAtMs?: number;
}

export interface ConversationProjectionRow<Value> {
  readonly projection: ConversationProjection;
  readonly value: Value;
  readonly occurredAtMs: number | null;
}

export type OrderedConversationRow<Durable, Projection> =
  | { readonly kind: "durable"; readonly key: string; readonly value: Durable }
  | {
      readonly kind: "projection";
      readonly key: string;
      readonly projection: ConversationProjection;
      readonly value: Projection;
    };

export function conversationProjectionKey(projection: ConversationProjection): string {
  return "id" in projection ? `${projection.kind}:${projection.id}` : projection.kind;
}

export function conversationUlidTime(value: string): number | null {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) return null;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let result = 0;
  for (const character of value.slice(0, 10)) {
    const digit = alphabet.indexOf(character);
    if (digit === -1) return null;
    result = result * 32 + digit;
  }
  return result;
}

export function orderConversationRows<Durable, Projection>(input: {
  readonly durable: readonly ConversationRow<Durable>[];
  readonly projections: readonly ConversationProjectionRow<Projection>[];
}): readonly OrderedConversationRow<Durable, Projection>[] {
  const present = new Set(input.durable.map((row) => row.key));
  const fresh = input.projections
    .map((entry) => ({ ...entry, key: conversationProjectionKey(entry.projection) }))
    .filter((entry) => !present.has(entry.key));
  const timed = fresh
    .filter((entry) => entry.occurredAtMs !== null)
    .sort((left, right) => left.occurredAtMs! - right.occurredAtMs!);
  const live = fresh.filter((entry) => entry.occurredAtMs === null);
  const rows: OrderedConversationRow<Durable, Projection>[] = [];
  const pushProjection = (entry: (typeof fresh)[number]): void => {
    rows.push({
      kind: "projection",
      key: entry.key,
      projection: entry.projection,
      value: entry.value,
    });
  };
  let next = 0;
  let reached = Number.NEGATIVE_INFINITY;
  for (const row of input.durable) {
    reached = Math.max(reached, row.occurredAtMs ?? reached);
    while (next < timed.length && timed[next]!.occurredAtMs! < reached) {
      pushProjection(timed[next]!);
      next += 1;
    }
    rows.push({ kind: "durable", key: row.key, value: row.value });
  }
  for (const entry of [...timed.slice(next), ...live]) pushProjection(entry);
  return rows;
}

export function pendingNavigations(input: {
  readonly planCreation: { readonly creationId: string; readonly hasDraft: boolean } | null;
  readonly planChanges: readonly Pick<PlanChangeModel, "changeId" | "status">[];
  readonly decision: Pick<CoachDecisionReadModel, "decisionId" | "status"> | null;
}): readonly PendingNavigation[] {
  const pending: PendingNavigation[] = [];
  if (input.planCreation?.hasDraft === true) {
    pending.push({
      key: `plan-creation:${input.planCreation.creationId}`,
      kind: "plan-creation",
    });
  }
  const planChange = input.planChanges.find((change) => change.status === "pending");
  if (planChange !== undefined) {
    pending.push({ key: `plan-change:${planChange.changeId}`, kind: "plan-change" });
  }
  if (input.decision?.status === "unanswered") {
    pending.push({
      key: `coach-decision:${input.decision.decisionId}`,
      kind: "coach-decision",
    });
  }
  return pending;
}

export function sourceActionIsAbove(sourceBottom: number, conversationTop: number): boolean {
  return sourceBottom <= conversationTop;
}

export function compensateScrollTop(
  scrollTop: number,
  previousConversationTop: number,
  conversationTop: number,
): number {
  return Math.max(0, scrollTop + conversationTop - previousConversationTop);
}

export function destinationScrollTop(input: {
  readonly scrollTop: number;
  readonly cardTop: number;
  readonly conversationTop: number;
  readonly inset?: number;
}): number {
  return Math.max(0, input.scrollTop + input.cardTop - input.conversationTop - (input.inset ?? 8));
}

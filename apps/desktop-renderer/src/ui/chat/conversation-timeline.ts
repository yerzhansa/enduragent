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
  | { readonly kind: "coach-progress"; readonly id: string };

export interface PendingNavigation {
  readonly key: `plan-creation:${string}` | `plan-change:${string}` | `coach-decision:${string}`;
  readonly kind: "plan-creation" | "plan-change" | "coach-decision";
}

export interface ConversationRow<Value> {
  readonly key: string;
  readonly value: Value;
  readonly occurredAtMs?: number;
}

export type OrderedConversationRow<Durable, Projection> =
  | { readonly kind: "durable"; readonly key: string; readonly value: Durable }
  | {
      readonly kind: "projection";
      readonly key: string;
      readonly projection: ConversationProjection;
      readonly value: Projection;
    };

interface ProjectionPlacement {
  readonly afterKey: string | null;
}

export interface ConversationInsertionLedger {
  readonly resetCount: number;
  readonly placements: Map<string, ProjectionPlacement>;
}

export function createConversationInsertionLedger(resetCount: number): ConversationInsertionLedger {
  return { resetCount, placements: new Map() };
}

export function resetConversationInsertionLedger(input: {
  readonly previous: ConversationInsertionLedger;
  readonly resetCount: number;
  readonly projections: readonly ConversationProjection[];
}): ConversationInsertionLedger {
  const next = createConversationInsertionLedger(input.resetCount);
  let afterKey: string | null = null;
  for (const projection of input.projections) {
    const key = conversationProjectionKey(projection);
    if (!input.previous.placements.has(key)) continue;
    next.placements.set(key, { afterKey });
    afterKey = key;
  }
  return next;
}

export function conversationProjectionKey(projection: ConversationProjection): string {
  if (projection.kind === "coach-decision-availability") return projection.kind;
  return `${projection.kind}:${projection.id}`;
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

export function chronologicalConversationPredecessor(
  rows: readonly ConversationRow<unknown>[],
  occurredAtMs: number | null,
): string | null | undefined {
  if (occurredAtMs === null || rows.some((row) => row.occurredAtMs === undefined)) {
    return undefined;
  }
  let predecessor: string | null = null;
  for (const row of rows) {
    if (row.occurredAtMs === undefined) return undefined;
    if (row.occurredAtMs <= occurredAtMs) predecessor = row.key;
  }
  return predecessor;
}

export function recoverConversationPredecessor(
  rows: readonly ConversationRow<unknown>[],
  occurredAtMs: number | null,
  structuralPredecessor: string | null,
): string | null {
  const chronological = chronologicalConversationPredecessor(rows, occurredAtMs);
  return chronological === undefined ? structuralPredecessor : chronological;
}

export function forgetConversationProjection(
  ledger: ConversationInsertionLedger,
  projection: ConversationProjection,
): void {
  ledger.placements.delete(conversationProjectionKey(projection));
}

function resolveAnchorIndex(
  rows: readonly { readonly key: string }[],
  afterKey: string | null,
  ledger: ConversationInsertionLedger,
): number {
  let candidate = afterKey;
  const visited = new Set<string>();
  while (candidate !== null && !visited.has(candidate)) {
    const index = rows.findIndex((row) => row.key === candidate);
    if (index !== -1) return index;
    visited.add(candidate);
    candidate = ledger.placements.get(candidate)?.afterKey ?? null;
  }
  return -1;
}

export function orderConversationRows<Durable, Projection>(input: {
  readonly durable: readonly ConversationRow<Durable>[];
  readonly projections: readonly {
    readonly projection: ConversationProjection;
    readonly value: Projection;
    readonly afterKey?: string | null;
  }[];
  readonly ledger: ConversationInsertionLedger;
  readonly rememberNewPlacements: boolean;
}): readonly OrderedConversationRow<Durable, Projection>[] {
  const rows: OrderedConversationRow<Durable, Projection>[] = input.durable.map((row) => ({
    kind: "durable",
    ...row,
  }));
  const present = new Set(rows.map((row) => row.key));
  for (const entry of input.projections) {
    const key = conversationProjectionKey(entry.projection);
    if (present.has(key)) continue;
    const placement = input.ledger.placements.get(key) ?? {
      afterKey: entry.afterKey === undefined ? (rows.at(-1)?.key ?? null) : entry.afterKey,
    };
    if (!input.ledger.placements.has(key) && input.rememberNewPlacements) {
      input.ledger.placements.set(key, placement);
    }
    const anchorIndex = resolveAnchorIndex(rows, placement.afterKey, input.ledger);
    let insertionIndex = anchorIndex + 1;
    while (rows[insertionIndex]?.kind === "projection") insertionIndex += 1;
    rows.splice(insertionIndex, 0, {
      kind: "projection",
      key,
      projection: entry.projection,
      value: entry.value,
    });
    present.add(key);
  }
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

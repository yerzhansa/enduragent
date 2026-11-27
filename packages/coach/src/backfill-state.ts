import { createSyncStateRepository, type SqlStore } from "@enduragent/kernel/store";

export interface BackfillCursor {
  readonly v: 1;
  readonly cycle: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly last_key: string | null;
  readonly complete: boolean;
}

export type BackfillState =
  | { readonly kind: "not-started" }
  | { readonly kind: "in-progress"; readonly cursor: BackfillCursor }
  | { readonly kind: "complete" };

export function parseBackfillCursor(value: string | null): BackfillCursor {
  if (value === null) throw new TypeError("source cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("source cursor is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join(",") !== "v,cycle,window_start,window_end,last_key,complete"
  ) {
    throw new TypeError("source cursor is invalid");
  }
  const item = parsed as Record<string, unknown>;
  if (
    item.v !== 1 ||
    typeof item.cycle !== "number" ||
    !Number.isSafeInteger(item.cycle) ||
    item.cycle < 0 ||
    typeof item.window_start !== "string" ||
    typeof item.window_end !== "string" ||
    (item.last_key !== null && typeof item.last_key !== "string") ||
    typeof item.complete !== "boolean" ||
    JSON.stringify(item) !== value
  ) {
    throw new TypeError("source cursor is invalid");
  }
  return {
    v: item.v,
    cycle: item.cycle,
    window_start: item.window_start,
    window_end: item.window_end,
    last_key: item.last_key,
    complete: item.complete,
  };
}

export async function readBackfillState(store: SqlStore): Promise<BackfillState> {
  const saved = await createSyncStateRepository(store).readWatermark("intervals-icu", "bulk-fit");
  if (saved.value === null) return { kind: "not-started" };
  const cursor = parseBackfillCursor(saved.value);
  return cursor.complete ? { kind: "complete" } : { kind: "in-progress", cursor };
}

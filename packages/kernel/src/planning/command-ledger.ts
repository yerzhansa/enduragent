import { canonicalJson } from "../archive/canonical.js";
import type { SqlStore, Row } from "../store/ports.js";

export type PlanCreationErrorCode =
  | "command-conflict"
  | "stale-version"
  | "missing-creation"
  | "no-unfinished-creation"
  | "corrupt-record"
  | "version-conflict"
  | "not-ready"
  | "commitments-pending";

export class PlanCreationStoreError extends Error {
  constructor(readonly code: PlanCreationErrorCode) {
    super(
      code === "not-ready"
        ? "Build a current complete Draft and resolve pending answers before activation."
        : code === "commitments-pending"
          ? "Clarify or cancel the pending commitment correction."
          : code,
    );
    this.name = "PlanCreationStoreError";
  }
}

export interface PlanCreationCommandStamp {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly nowMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export type PlanningCommandName =
  | "plan_creation.start"
  | "plan_creation.answer"
  | "plan_creation.discard"
  | "plan_creation.preview"
  | "plan_creation.activate"
  | "plan.close"
  | "plan_change.preview"
  | "plan_change.apply";

export const fail = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};
const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};

export function createPlanningCommandLedger(store: SqlStore) {
  const hasReplay = async (name: PlanningCommandName, command: PlanCreationCommandStamp) => {
    const row = await store.get(
      "SELECT request_digest,status,result_json FROM planning_command WHERE command_name=? AND command_id=?",
      [name, command.commandId],
    );
    if (row === undefined) return undefined;
    if (text(row, "request_digest") !== command.requestDigest)
      throw new PlanCreationStoreError("command-conflict");
    if (text(row, "status") !== "succeeded") fail();
    return row;
  };
  const recordCommand = (
    name: PlanningCommandName,
    command: PlanCreationCommandStamp,
    aggregateRefs:
      | { readonly creationId: string }
      | { readonly planId: string }
      | { readonly planId: string; readonly planChangeId: string },
    result: unknown,
  ) =>
    store.run(
      `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, 'succeeded', ?, ?, NULL, NULL, 2, ?, ?, ?, ?, ?)`,
      [
        name,
        command.commandId,
        command.requestDigest,
        canonicalJson(aggregateRefs),
        canonicalJson(result),
        command.nowMs,
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
      ],
    );
  return { hasReplay, recordCommand };
}

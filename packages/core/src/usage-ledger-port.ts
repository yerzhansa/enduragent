import type { UsagePort } from "@enduragent/engine";
import { appendUsageLine, readUsageLedger } from "./usage-ledger.js";

export function usageLedgerPort(dataDir: string): UsagePort {
  return {
    append: (line) => appendUsageLine(dataDir, line),
    callsForTurn: (turnId) =>
      readUsageLedger(dataDir).lines.filter(
        (line) => line.kind === "generate" && line.turnId === turnId,
      ),
  };
}

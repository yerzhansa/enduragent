import type { SpendRouteSummary, SpendSummary } from "@enduragent/coach-contract";
import type { SpendMeterState, SpendMeterView } from "../../spend-meter/controller";
import type { SpendSettingsPort, SpendSurfaceState } from "../settings-slice";

const SPEND_CAP_REACHED_PREFIX = "You’ve reached today’s ";

export function currency(value: number, detail = false): string {
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.01) return detail ? `$${value.toFixed(4)}` : "<$0.01";
  return `$${value.toFixed(2)}`;
}

function capWarningCopy(summary: SpendSummary | null): string | null {
  if (summary?.capStatus !== "reached") return null;
  return `${SPEND_CAP_REACHED_PREFIX}${currency(summary.dailyCapUsd)} spend cap. You can keep chatting; this is a warning, not a block.`;
}

export function notionalSpendCopy(summary: SpendSummary): string | null {
  const notional = summary.notionalSpendUsd ?? 0;
  if (notional <= 0) return null;
  return `Subscription usage would have cost ${currency(notional, true)} on the API. No money moved, and it does not count toward your cap.`;
}

export function routeSpendCopy(route: SpendRouteSummary): string {
  const notional = route.notionalSpendUsd ?? 0;
  const parts: string[] = [];
  if (notional === 0 || route.knownSpendUsd > 0) parts.push(currency(route.knownSpendUsd, true));
  if (notional > 0) parts.push(`would have cost ${currency(notional, true)} on the API`);
  parts.push(`${route.pricedGenerationCount}/${route.generationCount} generations priced`);
  return parts.join(" · ");
}

export interface SpendSettingsAdapter {
  readonly view: SpendMeterView;
  readonly port: SpendSettingsPort;
}

export function createSpendSettingsAdapter(input: {
  readonly publish: (next: SpendSurfaceState) => void;
}): SpendSettingsAdapter {
  let handlers:
    | {
        readonly onChangeCap: (value: string) => void;
        readonly onCommitCap: () => void;
        readonly onRetryCap: () => void;
      }
    | undefined;
  let disposed = false;

  return {
    view: {
      bind(next) {
        handlers = next;
      },
      render(state: SpendMeterState) {
        if (disposed) return;
        input.publish({ ...state, warning: capWarningCopy(state.summary) });
      },
      dispose() {
        disposed = true;
        handlers = undefined;
      },
    },
    port: {
      changeCap(value) {
        handlers?.onChangeCap(value);
      },
      commitCap() {
        handlers?.onCommitCap();
      },
      retryCap() {
        handlers?.onRetryCap();
      },
    },
  };
}

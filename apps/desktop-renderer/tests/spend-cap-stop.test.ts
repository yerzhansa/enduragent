import type { SpendSummary, TurnRefusal } from "@enduragent/coach-contract";
import { msg } from "@enduragent/i18n";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_DECISION_FAILURE_COPY,
  decisionFailureCopy,
  spendCapRefusalCopy,
  unansweredDrainAction,
} from "../src/chat/controller-helpers";
import { capRefusesTurns, resumeChatWhenCapLifts } from "../src/state/adapters/spend";
import { chatFeedbackMessage, spendWarningMessage } from "../src/ui/chat/copy";

const refusal: TurnRefusal = { kind: "spend-cap-reached", dailyCapUsd: 0.5, knownSpendUsd: 0.62 };

const REFUSAL_COPY =
  "Today’s model spend has reached your $0.50 daily cap, so the coach didn’t answer. To keep going today, raise the cap or switch it to Warn in Settings › Spending.";

function summary(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.62,
    generationCount: 3,
    pricedGenerationCount: 3,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "reached",
    capMode: "enforce",
    cacheReadTokens: 0,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: true,
    routes: [],
    ...overrides,
  };
}

interface SpendState {
  readonly settings: { readonly spend: { readonly summary: SpendSummary | null } };
}

function spendStore(initial: SpendSummary | null) {
  let state: SpendState = { settings: { spend: { summary: initial } } };
  const listeners = new Set<(next: SpendState, previous: SpendState) => void>();
  return {
    subscribe(listener: (next: SpendState, previous: SpendState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: SpendSummary | null) {
      const previous = state;
      state = { settings: { spend: { summary: next } } };
      for (const listener of listeners) listener(state, previous);
    },
  };
}

describe("spend cap Stop mode in the renderer", () => {
  it("treats only a reached cap in Stop mode as refusing turns", () => {
    expect(capRefusesTurns(summary())).toBe(true);
    expect(capRefusesTurns(summary({ capMode: "warn" }))).toBe(false);
    expect(capRefusesTurns(summary({ capStatus: "below" }))).toBe(false);
    expect(capRefusesTurns(summary({ capStatus: "unknown" }))).toBe(false);
    expect(capRefusesTurns(null)).toBe(false);
  });

  it("resumes the chat queue once, when a refusing cap lifts", () => {
    const store = spendStore(summary());
    const resume = vi.fn(async () => {});
    const dispose = resumeChatWhenCapLifts(store, resume);

    store.publish(summary({ knownSpendUsd: 0.7 }));
    expect(resume).not.toHaveBeenCalled();

    store.publish(summary({ dailyCapUsd: 1, capStatus: "below" }));
    expect(resume).toHaveBeenCalledTimes(1);

    store.publish(summary({ dailyCapUsd: 1, capStatus: "below", knownSpendUsd: 0.8 }));
    store.publish(summary({ capMode: "warn" }));
    expect(resume).toHaveBeenCalledTimes(1);

    store.publish(summary());
    store.publish(summary({ capMode: "warn" }));
    expect(resume).toHaveBeenCalledTimes(2);

    dispose();
    store.publish(summary());
    store.publish(summary({ capStatus: "below" }));
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("discards an unanswered queued turn and keeps the refusal copy as its notice", () => {
    expect(unansweredDrainAction(7, refusal)).toEqual({
      type: "discard-submission",
      requestKey: 7,
      copy: REFUSAL_COPY,
    });
    expect(unansweredDrainAction(7, undefined)).toEqual({
      type: "discard-submission",
      requestKey: 7,
    });
  });

  it("explains a refused decision answer and keeps the generic failure otherwise", () => {
    expect(decisionFailureCopy(refusal)).toBe(REFUSAL_COPY);
    expect(decisionFailureCopy(undefined)).toBe(CHAT_DECISION_FAILURE_COPY);
  });

  it("maps the refusal and the Stop banner to their catalog messages", () => {
    expect(spendCapRefusalCopy(refusal)).toBe(REFUSAL_COPY);
    expect(chatFeedbackMessage(REFUSAL_COPY)).toEqual(
      msg("coach.refusal.spendCapReached", { cap: "$0.50" }),
    );
    expect(
      spendWarningMessage(
        "You’ve reached today’s $0.50 spend cap. New messages wait until tomorrow, or raise the cap or switch to Warn in Settings › Spending.",
        "0,50 $",
      ),
    ).toEqual(msg("chat.spend.capReachedStop", { amount: "0,50 $" }));
    expect(
      spendWarningMessage(
        "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
      ),
    ).toEqual(msg("chat.spend.capReached", { amount: "$0.50" }));
  });
});

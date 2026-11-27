import type { FinishReason, ModelMessage } from "ai";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { LanguageModelPort } from "../sport.js";
import { STEP_LIMIT_TRUNCATION_MESSAGE } from "./coach-agent-copy.js";
import type { TurnBudget } from "./turn-budget.js";
import type { RecoveredText, StepExhaustedRecovery } from "./workout-reply.js";

const RECOVERY_PROMPT =
  "Answer the athlete's latest request directly. Do not recap earlier conversation, infer pending approvals, or claim that you took any action. No tools are available for this response.";

function isStepExhaustedEmpty(text: string, finishReason: FinishReason): boolean {
  return text.trim() === "" && (finishReason === "tool-calls" || finishReason === "length");
}

export interface StepLimitRecoveryInput {
  readonly llm: LanguageModelPort;
  readonly phrasebook: Promise<Phrasebook>;
  readonly system: string;
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly messages: ModelMessage[];
  readonly cacheKey: string;
  readonly turnId: string;
  readonly budget: TurnBudget;
  readonly onTextDelta: (delta: string) => void;
  readonly signal: AbortSignal;
}

async function truncationFloor(phrasebook: Promise<Phrasebook>): Promise<RecoveredText> {
  return {
    text: (await phrasebook).say(STEP_LIMIT_TRUNCATION_MESSAGE),
    message: STEP_LIMIT_TRUNCATION_MESSAGE,
    attributionBasis: "none",
  };
}

export async function recoverStepExhaustedText(
  input: StepLimitRecoveryInput,
): Promise<StepExhaustedRecovery> {
  if (!isStepExhaustedEmpty(input.text, input.finishReason)) {
    return { kind: "unchanged", reply: { text: input.text, attributionBasis: "attempt" } };
  }
  input.budget.chargeGenerateCall();
  try {
    const recovery = await input.llm.generate({
      system: input.system,
      messages: [...input.messages, { role: "user", content: RECOVERY_PROMPT }],
      tools: undefined,
      caller: "chat",
      turnId: input.turnId,
      cacheKey: input.cacheKey,
      deadlineMs: input.budget.remainingMs(),
      onTextDelta: input.onTextDelta,
      signal: input.signal,
    });
    return recovery.text.trim() !== ""
      ? {
          kind: "generated",
          result: recovery,
          reply: { text: recovery.text, attributionBasis: "prompt" },
        }
      : { kind: "fixed", reply: await truncationFloor(input.phrasebook) };
  } catch (recoveryErr) {
    if (input.signal.aborted) throw recoveryErr;
    console.warn("Step-limit recovery completion failed; using truncation floor", recoveryErr);
    return { kind: "fixed", reply: await truncationFloor(input.phrasebook) };
  }
}

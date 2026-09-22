import { stepCountIs } from "ai";
import type { FinishReason, ModelMessage, ToolSet } from "ai";
import type { Message } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { LoggerPort } from "../host-ports.js";
import type { GenerateResult, LanguageModelPort } from "../sport.js";
import type { TurnContext } from "./turn-context.js";
import { TurnBudgetExceededError, type TurnBudget } from "./turn-budget.js";
import {
  assessWorkoutPreparation,
  workoutPreparationCorrectionMessages,
} from "./workout-preparation-recovery.js";
import type { WorkoutPreparationSession } from "./workout-preparation.js";
import {
  PROTOCOL_FAILURE_MESSAGE,
  SAVED_INFORMATION_UNVERIFIED_MESSAGE,
  WORKOUT_PREPARATION_FAILED_MESSAGE,
  WORKOUT_PREPARATION_PREPARED_MESSAGE,
  WORKOUT_PREPARATION_SAVED_INFORMATION_FAILED_MESSAGE,
} from "./coach-agent-copy.js";
import { COACH_DECISION_TOOL_NAME } from "./coach-decision-tool.js";
import { PLAN_HANDOFF_TOOL_NAME } from "./plan-handoff-tool.js";
import { PLAN_INTAKE_TOOL_NAME } from "./plan-intake-tool.js";

export interface RecoveredText {
  text: string;
  message?: Message;
  attributionBasis: "attempt" | "prompt" | "none";
}

export type StepExhaustedRecovery =
  | { readonly kind: "unchanged"; readonly reply: RecoveredText }
  | {
      readonly kind: "generated";
      readonly result: GenerateResult;
      readonly reply: RecoveredText;
    }
  | { readonly kind: "fixed"; readonly reply: RecoveredText };

interface WorkoutReplyState {
  result: GenerateResult;
  messages: ModelMessage[];
  tools: ToolSet;
}

type WorkoutReplyVerification =
  | ({ readonly kind: "continue" } & WorkoutReplyState)
  | ({ readonly kind: "verified"; readonly reply: RecoveredText } & WorkoutReplyState);

export interface ResolvedTurnReply {
  readonly result: GenerateResult;
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly finishReason: FinishReason;
  readonly recovered: RecoveredText;
}

function correctionTools(
  tools: ToolSet,
  replayUnsafeToolNames: ReadonlySet<string>,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        !replayUnsafeToolNames.has(name) &&
        name !== COACH_DECISION_TOOL_NAME &&
        name !== PLAN_HANDOFF_TOOL_NAME &&
        name !== PLAN_INTAKE_TOOL_NAME,
    ),
  );
}

async function verifyWorkoutReply(input: {
  session: WorkoutPreparationSession;
  result: GenerateResult;
  messages: ModelMessage[];
  tools: ToolSet;
  system: string;
  context: TurnContext;
  budget: TurnBudget;
  cacheKey: string;
  signal: AbortSignal;
  llm: LanguageModelPort;
  phrasebook: Phrasebook;
  log: LoggerPort;
  replayUnsafeToolNames: ReadonlySet<string>;
}): Promise<WorkoutReplyVerification> {
  const book = input.phrasebook;
  const failure = (): WorkoutReplyVerification => {
    input.session.fail();
    const message =
      input.context.turnWrites.writesCommitted > 0
        ? WORKOUT_PREPARATION_SAVED_INFORMATION_FAILED_MESSAGE
        : WORKOUT_PREPARATION_FAILED_MESSAGE;
    return {
      kind: "verified",
      result: input.result,
      messages: input.messages,
      tools: input.tools,
      reply: {
        text: book.say(message),
        message,
        attributionBasis: "none",
      },
    };
  };
  const protocolFailure = (): WorkoutReplyVerification => {
    input.session.fail();
    const message =
      input.context.turnWrites.writesCommitted > 0
        ? SAVED_INFORMATION_UNVERIFIED_MESSAGE
        : PROTOCOL_FAILURE_MESSAGE;
    return {
      kind: "verified",
      result: input.result,
      messages: input.messages,
      tools: input.tools,
      reply: {
        text: book.say(message),
        message,
        attributionBasis: "none",
      },
    };
  };
  const accepted = (
    result: GenerateResult,
    messages: ModelMessage[],
    tools: ToolSet,
  ): WorkoutReplyVerification => ({
    kind: "verified",
    result,
    messages,
    tools,
    reply:
      result.text.trim() === ""
        ? {
            text: book.say(WORKOUT_PREPARATION_PREPARED_MESSAGE),
            message: WORKOUT_PREPARATION_PREPARED_MESSAGE,
            attributionBasis: "none",
          }
        : { text: result.text, attributionBasis: "attempt" },
  });
  const attempt = await input.session.inspect();
  input.budget.checkDeadline();
  input.signal.throwIfAborted();
  if (attempt.kind === "failed") return failure();
  if (attempt.kind === "prepared") {
    return input.result.finishReason === "stop"
      ? accepted(input.result, input.messages, input.tools)
      : failure();
  }

  const assessment = await assessWorkoutPreparation({
    llm: input.llm,
    messages: input.messages,
    candidate: input.result.text,
    budget: input.budget,
    signal: input.signal,
    cacheKey: input.cacheKey,
  });
  input.budget.checkDeadline();
  input.signal.throwIfAborted();
  input.log.info("workout_preparation_assessment", { outcome: assessment.kind });
  if (assessment.kind === "assessment_failed") return protocolFailure();
  if (assessment.kind === "no_preparation_required")
    return {
      kind: "continue",
      result: input.result,
      messages: input.messages,
      tools: input.tools,
    };
  if (input.result.finishReason !== "stop") return failure();
  if (input.context.turnWrites.writesCommitted > 0) return failure();

  const messages = workoutPreparationCorrectionMessages(input.messages, input.result.text);
  const tools = correctionTools(input.tools, input.replayUnsafeToolNames);
  input.budget.chargeAttempt();
  input.budget.chargeGenerateCall();
  let result: GenerateResult;
  try {
    result = await input.llm.generate({
      system: input.system,
      messages,
      tools,
      stopWhen: stepCountIs(10),
      maxSteps: 10,
      caller: "chat",
      context: input.context,
      cacheKey: input.cacheKey,
      deadlineMs: input.budget.remainingMs(),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted || error instanceof TurnBudgetExceededError) throw error;
    input.log.info("workout_preparation_recovery", { outcome: "provider_failure" });
    return failure();
  }
  input.budget.checkDeadline();
  input.signal.throwIfAborted();
  const recovered = await input.session.inspect();
  input.log.info("workout_preparation_recovery", { outcome: recovered.kind });
  if (recovered.kind !== "prepared" || result.finishReason !== "stop") return failure();
  return accepted(result, messages, tools);
}

export async function resolveTurnReply(input: {
  readonly session: WorkoutPreparationSession | undefined;
  readonly result: GenerateResult;
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly system: string;
  readonly context: TurnContext;
  readonly budget: TurnBudget;
  readonly cacheKey: string;
  readonly signal: AbortSignal;
  readonly llm: LanguageModelPort;
  readonly phrasebook: Phrasebook;
  readonly log: LoggerPort;
  readonly replayUnsafeToolNames: ReadonlySet<string>;
  readonly recoverStepExhausted: (
    text: string,
    finishReason: FinishReason,
    messages: ModelMessage[],
  ) => Promise<StepExhaustedRecovery>;
}): Promise<ResolvedTurnReply> {
  let result = input.result;
  let messages = input.messages;
  let tools = input.tools;
  let finishReason = input.finishReason;
  let workoutReply =
    input.session === undefined
      ? undefined
      : await verifyWorkoutReply({
          session: input.session,
          result: { ...result, text: input.text, finishReason },
          messages,
          tools,
          system: input.system,
          context: input.context,
          budget: input.budget,
          cacheKey: input.cacheKey,
          signal: input.signal,
          llm: input.llm,
          phrasebook: input.phrasebook,
          log: input.log,
          replayUnsafeToolNames: input.replayUnsafeToolNames,
        });
  if (workoutReply !== undefined) {
    result = workoutReply.result;
    messages = workoutReply.messages;
    tools = workoutReply.tools;
    finishReason = result.finishReason;
  }
  if (workoutReply?.kind === "verified") {
    return { result, messages, tools, finishReason, recovered: workoutReply.reply };
  }
  const stepRecovery = await input.recoverStepExhausted(input.text, finishReason, messages);
  let recovered = stepRecovery.reply;
  if (
    input.session !== undefined &&
    workoutReply?.kind === "continue" &&
    stepRecovery.kind === "generated"
  ) {
    workoutReply = await verifyWorkoutReply({
      session: input.session,
      result: stepRecovery.result,
      messages,
      tools,
      system: input.system,
      context: input.context,
      budget: input.budget,
      cacheKey: input.cacheKey,
      signal: input.signal,
      llm: input.llm,
      phrasebook: input.phrasebook,
      log: input.log,
      replayUnsafeToolNames: input.replayUnsafeToolNames,
    });
    result = workoutReply.result;
    messages = workoutReply.messages;
    tools = workoutReply.tools;
    finishReason = result.finishReason;
    if (workoutReply.kind === "verified") recovered = workoutReply.reply;
  }
  return { result, messages, tools, finishReason, recovered };
}

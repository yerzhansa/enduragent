import { msg, type Message } from "@enduragent/i18n";

export const TAINTED_BY_WRITES_MESSAGE = msg("coach.fallback.writesSaved");
export const STEP_LIMIT_TRUNCATION_MESSAGE = msg("coach.fallback.stepLimit");
export const PROTOCOL_FAILURE_MESSAGE = msg("chat.notice.protocolFailure");
export const SAVED_INFORMATION_UNVERIFIED_MESSAGE = msg("chat.notice.savedUnverified");
export const DISK_FULL_NOTE = msg("coach.history.diskFull");
export const WORKOUT_PREPARATION_FAILED_MESSAGE = msg("coach.workoutPreparation.failed");
export const WORKOUT_PREPARATION_PREPARED_MESSAGE = msg("coach.workoutPreparation.prepared");
export const WORKOUT_PREPARATION_SAVED_INFORMATION_FAILED_MESSAGE = msg(
  "coach.workoutPreparation.savedInformationFailed",
);

export function coachReplyMessage(input: {
  readonly reply: string;
  readonly message?: Message;
  readonly reset: boolean;
  readonly unsaved: boolean;
}): Message | undefined {
  if (input.message?.key === STEP_LIMIT_TRUNCATION_MESSAGE.key) {
    if (input.reset && input.unsaved) return msg("coach.history.resetUnsavedStepLimit");
    if (input.reset) return msg("coach.history.resetStepLimit");
    if (input.unsaved) return msg("coach.history.unsavedStepLimit");
  }
  const vars = { reply: input.reply };
  if (input.reset && input.unsaved) return msg("coach.history.resetUnsavedReply", vars);
  if (input.reset) return msg("coach.history.resetReply", vars);
  if (input.unsaved) return msg("coach.history.unsavedReply", vars);
  return input.message;
}

import { msg, type Message } from "@enduragent/i18n";

export function chatFeedbackMessage(value: string): Message | null {
  switch (value) {
    case "This creation is no longer unfinished. Open the Plan library for its current result.":
      return msg("chat.notice.creationFinished");
    case "Connection interrupted. Your partial response is preserved.":
      return msg("chat.notice.connectionInterrupted");
    case "Response stopped. Your partial response is preserved.":
      return msg("chat.notice.responseStopped");
    case "The coaching response could not be verified. Please try again.":
      return msg("chat.notice.protocolFailure");
    case "The coach couldn't respond. Please try again.":
      return msg("chat.notice.responseFailure");
    case "The coach returned an empty response. Please try again.":
      return msg("chat.notice.emptyResponse");
    case "We couldn’t continue from your choice. Please try again.":
      return msg("chat.notice.decisionFailure");
    case "We couldn’t skip this question. Please try again.":
      return msg("chat.notice.decisionSkipFailure");
    case "We couldn’t check for a saved Coach question. Reconnect and try again.":
      return msg("chat.notice.decisionLoadFailure");
    case "We couldn’t check your saved messages. Reconnect and try again.":
      return msg("chat.notice.queueLoadFailure");
    case "We couldn’t remove that saved message. Try again.":
      return msg("chat.notice.queueRemoveFailure");
    case "We couldn’t update that attachment. Your message draft is preserved.":
      return msg("chat.notice.attachmentFailure");
    case "We couldn’t check saved Plan requests. Reconnect and try again.":
      return msg("chat.notice.planningRequestLoadFailure");
    case "Plan couldn’t receive this request. Your request is preserved and nothing changed in Plan.":
      return msg("chat.notice.planningRequestFailure");
    case "Plan Creation couldn’t save that. Try again.":
      return msg("chat.notice.creationSaveFailure");
    case "Plan Creation changed before it could be discarded. The latest version is shown.":
      return msg("chat.notice.creationDiscardStale");
    case "Plan Creation wasn’t discarded. Try again.":
      return msg("chat.notice.creationDiscardConflict");
    case "There is no unfinished Plan Creation to discard.":
      return msg("chat.notice.creationDiscardMissing");
    case "New conversation started.":
      return msg("chat.notice.newConversationSuccess");
    case "New conversation started. Some recent details may not have been saved to coach memory.":
      return msg("chat.notice.newConversationMemoryWarning");
    case "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.":
      return msg("chat.notice.newConversationUncertain");
    case "Coach is working…":
      return msg("chat.notice.working");
    case "Checking your training data…":
      return msg("chat.notice.checkingTraining");
    case "Saved choice":
      return msg("chat.notice.savedChoice");
    case "Question skipped":
      return msg("chat.notice.questionSkipped");
    case "No coaching choice was applied.":
      return msg("chat.notice.choiceUnchanged");
    case "Finish the Plan question above":
      return msg("chat.composer.finishPlanQuestion");
    case "Message your coach":
      return msg("chat.composer.messagePlaceholder");
    case "Keep your change request to 500 characters or fewer.":
      return msg("chat.planChange.feedback.requestTooLong");
    case "This Workout is no longer eligible.":
      return msg("chat.planChange.feedback.workoutIneligible");
    case "Enter FTP above zero.":
      return msg("chat.planChange.feedback.ftpPositive");
    case "Choose a Supporting Event already accepted in this Plan.":
      return msg("chat.planChange.feedback.supportingEventRequired");
    case "Enter the event name and exact date.":
      return msg("chat.planChange.feedback.eventDetailsRequired");
    case "Enter weekly hours in quarter-hour steps, like 2.25.":
      return msg("chat.planChange.feedback.weeklyQuarterHours");
    case "Enter a weekly duration above zero.":
      return msg("chat.planChange.feedback.weeklyDurationPositive");
    case "Choose the weekday to change.":
      return msg("chat.planChange.feedback.weekdayRequired");
    case "Enter a duration above zero.":
      return msg("chat.planChange.feedback.durationPositive");
    case "Only training reductions are allowed during this race window. Training is unchanged.":
      return msg("chat.planChange.feedback.raceWindowReduction");
    case "The latest Change is no longer eligible for Undo.":
      return msg("chat.planChange.feedback.undoIneligible");
    case "This request used an older Plan revision. Request a fresh preview.":
      return msg("chat.planChange.feedback.revisionChanged");
    case "This Change could not be previewed. Training is unchanged.":
      return msg("chat.planChange.feedback.previewFailed");
    case "Review the exact changes before confirming.":
      return msg("chat.planChange.feedback.confirmReview");
    case "The preview result could not be confirmed. The Plan library will show the current state after refresh.":
      return msg("chat.planChange.feedback.previewUncertain");
    case "This preview is no longer pending. Training is unchanged.":
      return msg("chat.planChange.feedback.previewExpired");
    case "The day changed while this choice was open. Request a fresh choice for today; no date was assigned.":
      return msg("chat.planChange.feedback.dayChanged");
    case "The synchronized event changed. Request a fresh preview before applying.":
      return msg("chat.planChange.feedback.eventChanged");
    case "Only training reductions are allowed in the current race window. This Change was not applied.":
      return msg("chat.planChange.feedback.raceWindowNotApplied");
    case "The FTP sources changed. Request a fresh preview before applying this correction.":
      return msg("chat.planChange.feedback.ftpChanged");
    case "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.":
      return msg("chat.planChange.feedback.previewStale");
    case "This Change could not be applied. Training and the pending preview are unchanged.":
      return msg("chat.planChange.feedback.applyFailed");
    case "Change applied locally. Training now matches the confirmed preview.":
      return msg("chat.planChange.feedback.applied");
    case "Change cancelled. Training is unchanged; the preview remains in history.":
      return msg("chat.planChange.feedback.cancelled");
    case "The Change result could not be confirmed. The Plan library will show the current state after refresh.":
      return msg("chat.planChange.feedback.applyUncertain");
    case "Plan Changes are paused because synchronized training is older than 24 hours. Refresh the connection, then request a fresh preview.":
      return msg("chat.planChange.feedback.sourcesPaused");
    case "Sources are available again. Request a fresh preview before applying.":
      return msg("chat.planChange.feedback.sourcesResumed");
    case "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.":
      return msg("chat.planCreation.feedback.workoutsUnavailable");
    case "Answer the remaining question before building.":
      return msg("chat.planCreation.feedback.answerRequired");
    case "The answers changed. Start a fresh build.":
      return msg("chat.planCreation.feedback.answersChanged");
    case "Build failed. Your answers and last complete Draft are preserved.":
      return msg("chat.planCreation.feedback.buildFailed");
    case "The current Plan could not be read. Refresh the Plan library before activating.":
      return msg("chat.planCreation.feedback.planReadFailed");
    case "Read the Plan library and confirm again.":
      return msg("chat.planCreation.feedback.readLibrary");
    case "The Plan changed. Read the Plan library and confirm again.":
      return msg("chat.planCreation.feedback.planChanged");
    case "Activation could not be saved locally. Your previous Plan is unchanged.":
      return msg("chat.planCreation.feedback.activationFailed");
    case "The activation result could not be confirmed. The Plan library will show the current state after refresh.":
      return msg("chat.planCreation.feedback.activationUncertain");
    case "Plan activated locally.":
      return msg("chat.planCreation.feedback.activated");
  }
  const superseded =
    /^This preview supersedes “([\s\S]*)”\. Training is unchanged until confirmation\.$/u.exec(
      value,
    );
  if (superseded !== null) {
    return msg("chat.planChange.feedback.superseded", { title: superseded[1] ?? "" });
  }
  return null;
}

export function spendWarningMessage(value: string, formattedAmount?: string): Message | null {
  const reached =
    /^You’ve reached today’s (.+) spend cap\. You can keep chatting; this is a warning, not a block\.$/u.exec(
      value,
    );
  return reached === null
    ? null
    : msg("chat.spend.capReached", { amount: formattedAmount ?? reached[1] ?? "" });
}

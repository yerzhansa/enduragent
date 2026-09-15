import { usePhrasebook } from "@enduragent/i18n/react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { chatFeedbackMessage } from "./copy";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { useWireMessageText } from "./use-wire-message-text";

export function Notice(props: { readonly inPlanCreation?: boolean }): ReactElement | null {
  const { say } = usePhrasebook();
  const notice = useEnduragentStore((state) => state.chat.notice);
  const descriptor = useEnduragentStore((state) => state.chat.noticeMessage);
  const tone = useEnduragentStore((state) => state.chat.noticeTone);
  const noticeRetry = useEnduragentStore((state) => state.chat.noticeRetry);
  const message = notice === null ? null : chatFeedbackMessage(notice);
  const text = useWireMessageText(
    descriptor !== undefined || message === null ? (notice ?? "") : say(message),
    descriptor,
  );
  const planCreation = useEnduragentStore((state) => state.chat.planCreation);
  if ((planCreation !== null) !== (props.inPlanCreation === true)) return null;
  const danger = tone === "danger";
  return (
    <div
      className={`chat-notice flex items-center justify-between gap-inset rounded-ctl p-row ${
        danger
          ? "border border-danger/40 bg-surface text-sm leading-5 text-danger"
          : "bg-surface-2 text-xs leading-4 text-ink-2"
      }`}
      role={danger ? "alert" : "status"}
      data-tone={tone}
      hidden={notice === null && !noticeRetry}
    >
      <span className="flex min-w-0 items-center gap-inset">
        {danger ? <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        <span>{text}</span>
      </span>
      <RetryBar />
    </div>
  );
}

export function CoachProgress(): ReactElement | null {
  const { say } = usePhrasebook();
  const progress = useEnduragentStore((state) => state.chat.coachProgress ?? null);
  const message = progress === null ? null : chatFeedbackMessage(progress);
  if (progress === null) return null;
  const label = message === null ? progress : say(message);
  return (
    <div
      className="coach-progress mt-row flex items-center gap-inset text-sm leading-5 text-ink"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <LoaderCircle
        className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

export function RetryBar(): ReactElement {
  const { say } = usePhrasebook();
  const noticeRetry = useEnduragentStore((state) => state.chat.noticeRetry);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  return (
    <Button
      type="button"
      className="chat-retry shrink-0"
      variant="outline"
      size="xs"
      hidden={!noticeRetry}
      disabled={workBlocked || actions === null}
      onClick={() => {
        if (!noticeRetry || workBlocked) return;
        actions?.retry();
      }}
    >
      {say("chat.notice.retryMessage")}
    </Button>
  );
}

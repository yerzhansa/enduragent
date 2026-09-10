import { usePhrasebook } from "@enduragent/i18n/react";
import { LoaderCircle } from "lucide-react";
import { chatFeedbackMessage } from "./copy";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { useWireMessageText } from "./use-wire-message-text";

export function Notice(props: { readonly inPlanCreation?: boolean }): ReactElement | null {
  const { say } = usePhrasebook();
  const notice = useEnduragentStore((state) => state.chat.notice);
  const descriptor = useEnduragentStore((state) => state.chat.noticeMessage);
  const message = notice === null ? null : chatFeedbackMessage(notice);
  const text = useWireMessageText(
    descriptor !== undefined || message === null ? (notice ?? "") : say(message),
    descriptor,
  );
  const planCreation = useEnduragentStore((state) => state.chat.planCreation);
  if ((planCreation !== null) !== (props.inPlanCreation === true)) return null;
  if (props.inPlanCreation) {
    return (
      <div
        className="chat-notice rounded-ctl bg-surface-2 p-row text-sm leading-5 text-ink"
        role="status"
        hidden={notice === null}
      >
        <p className="m-0 text-xs leading-4 text-ink-2">{text}</p>
      </div>
    );
  }
  return (
    <p className="chat-notice m-0 text-sm leading-5 text-ink-2" hidden={notice === null}>
      {text}
    </p>
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
  const interrupted = useEnduragentStore((state) => state.chat.interrupted);
  const retryRequired = useEnduragentStore((state) => state.chat.retryRequired);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  return (
    <Button
      type="button"
      className="chat-retry mt-row mb-row justify-self-start"
      variant="outline"
      size="sm"
      hidden={!interrupted || retryRequired !== null}
      disabled={workBlocked}
      onClick={() => {
        if (!interrupted || retryRequired !== null || workBlocked) return;
        actions?.retry();
      }}
    >
      {say("chat.notice.retryMessage")}
    </Button>
  );
}

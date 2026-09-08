import type { ReactElement } from "react";
import { Button, ProgressDisplay } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function Notice(props: { readonly inPlanCreation?: boolean }): ReactElement | null {
  const notice = useEnduragentStore((state) => state.chat.notice);
  const planCreation = useEnduragentStore((state) => state.chat.planCreation);
  if ((planCreation !== null) !== (props.inPlanCreation === true)) return null;
  if (props.inPlanCreation) {
    return (
      <div
        className="chat-notice rounded-ctl bg-surface-2 p-row text-sm leading-5 text-ink"
        role="status"
        hidden={notice === null}
      >
        <p className="m-0 text-xs leading-4 text-ink-2">{notice ?? ""}</p>
      </div>
    );
  }
  return (
    <p className="chat-notice m-0 text-sm leading-5 text-ink-2" hidden={notice === null}>
      {notice ?? ""}
    </p>
  );
}

export function CoachProgress(): ReactElement | null {
  const progress = useEnduragentStore((state) => state.chat.coachProgress ?? null);
  if (progress === null) return null;
  return (
    <ProgressDisplay
      className="coach-progress mt-row rounded-card border border-line bg-surface p-ctl-px"
      role="status"
      aria-live="polite"
      aria-busy="true"
      label={progress}
      value={{ kind: "indeterminate" }}
    />
  );
}

export function RetryBar(): ReactElement {
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
      Retry message
    </Button>
  );
}

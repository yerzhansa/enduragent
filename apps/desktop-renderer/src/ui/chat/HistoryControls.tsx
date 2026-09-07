import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { TRANSCRIPT_HYDRATION_FAILURE_COPY } from "../../chat/hydration";
import { useEnduragentStore } from "../../state/store";

export function HistoryControls(): ReactElement {
  const status = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  const failed = status === "failed";
  const loadHidden = !hasEarlier || failed;
  const loadDisabled = status === "loading" || workBlocked;

  return (
    <div
      className="chat-history-controls flex items-center justify-start gap-inset"
      aria-live="off"
      hidden={!hasEarlier && !failed}
    >
      <Button
        type="button"
        className="chat-history-load"
        variant="outline"
        size="sm"
        hidden={loadHidden}
        disabled={loadDisabled}
        onClick={() => {
          if (loadHidden || loadDisabled) return;
          actions?.loadEarlier();
        }}
      >
        Load earlier messages
      </Button>
      <p className="chat-history-failure m-0 text-sm text-ink-2" hidden={!failed}>
        {TRANSCRIPT_HYDRATION_FAILURE_COPY}
      </p>
      <Button
        type="button"
        className="chat-history-retry"
        variant="outline"
        size="sm"
        hidden={!failed}
        disabled={workBlocked}
        onClick={() => {
          if (!failed || workBlocked) return;
          actions?.retryHydration();
        }}
      >
        Retry history
      </Button>
    </div>
  );
}

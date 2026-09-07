import { LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function Notice(): ReactElement {
  const notice = useEnduragentStore((state) => state.chat.notice);
  return (
    <p className="chat-notice m-0 text-sm text-ink-2" hidden={notice === null}>
      {notice ?? ""}
    </p>
  );
}

export function CoachProgress(): ReactElement | null {
  const progress = useEnduragentStore((state) => state.chat.coachProgress ?? null);
  if (progress === null) return null;
  return (
    <section
      className="coach-progress mt-row grid grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-inset rounded-card border border-line bg-surface p-ctl-px"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <LoaderCircle
        className="size-4 justify-self-center animate-spin text-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
      <strong className="text-sm font-medium leading-5">{progress}</strong>
    </section>
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

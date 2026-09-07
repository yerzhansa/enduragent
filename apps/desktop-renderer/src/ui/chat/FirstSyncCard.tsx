import { useEffect, useState, type ReactElement } from "react";
import { Button, ProgressDisplay } from "@enduragent/ui";
import { Card } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function FirstSyncCard(): ReactElement | null {
  const state = useEnduragentStore((store) => store.firstSync);
  const actions = useEnduragentStore((store) => store.chatActions);
  const [retrying, setRetrying] = useState(false);
  const status = state.status;

  useEffect(() => {
    setRetrying(false);
  }, [status]);

  if (status === "idle" || status === "ready") return null;

  const syncing = status === "syncing";
  const unreachable = state.status === "failed" && state.kind === "protocol";

  return (
    <Card
      className="first-sync my-6 w-full px-5 py-5 shadow-elev-1"
      data-state={status}
      role="region"
      aria-labelledby="first-sync-title"
    >
      <div className="first-sync__body min-w-0">
        <p className="first-sync__eyebrow m-0 text-xs font-semibold tracking-[0.08em] text-ink-2 uppercase">
          Getting your coach ready
        </p>
        <h2 id="first-sync-title" className="mt-inset mb-[calc(var(--inset)/2)] text-lg">
          {syncing
            ? "Syncing your training history…"
            : unreachable
              ? "Enduragent needs to reconnect safely"
              : "We couldn’t finish syncing"}
        </h2>
        <p className="first-sync__detail m-0 text-sm text-ink-2">
          {syncing
            ? "You can keep Enduragent open while rides, wellness, and calendar data are added."
            : unreachable
              ? "Quit and reopen Enduragent."
              : "Your saved progress is safe."}
        </p>
        {syncing ? (
          <ProgressDisplay
            className="first-sync__track mt-row"
            label="Syncing training history"
            value={{ kind: "indeterminate" }}
          />
        ) : null}
        {!syncing && !unreachable ? (
          <Button
            className="first-sync__retry mt-row"
            variant="outline"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              actions?.retryFirstSync();
            }}
          >
            Retry sync
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

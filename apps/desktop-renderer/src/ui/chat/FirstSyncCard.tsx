import { usePhrasebook } from "@enduragent/i18n/react";
import { useEffect, useState, type ReactElement } from "react";
import { Button, ProgressDisplay } from "@enduragent/ui";
import { Card } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

export function FirstSyncCard(): ReactElement | null {
  const { say } = usePhrasebook();
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
          {say("chat.firstSync.eyebrow")}
        </p>
        <h2 id="first-sync-title" className="mt-inset mb-[calc(var(--inset)/2)] text-lg">
          {syncing
            ? say("chat.firstSync.syncingTitle")
            : unreachable
              ? say("chat.firstSync.reconnectTitle", { product: "Enduragent" })
              : say("chat.firstSync.failedTitle")}
        </h2>
        <p className="first-sync__detail m-0 text-sm text-ink-2">
          {syncing
            ? say("chat.firstSync.syncingDetail", { product: "Enduragent" })
            : unreachable
              ? say("chat.firstSync.reconnectDetail", { product: "Enduragent" })
              : say("chat.firstSync.failedDetail")}
        </p>
        {syncing ? (
          <ProgressDisplay
            className="first-sync__track mt-row"
            label={say("chat.firstSync.progress")}
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
            {say("chat.firstSync.retry")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

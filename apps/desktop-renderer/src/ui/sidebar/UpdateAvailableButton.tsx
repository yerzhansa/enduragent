import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

interface UpdateAvailableButtonProps {
  readonly locked: boolean;
}

export function UpdateAvailableButton({ locked }: UpdateAvailableButtonProps): ReactElement {
  const update = useEnduragentStore((state) => state.settings.update);
  const updatePort = useEnduragentStore((state) => state.settingsPorts?.update ?? null);
  const visible = update.state.status === "downloaded" || update.state.status === "installing";
  const restarting = update.actionDisabled || update.state.status === "installing";
  const version = visible ? update.state.version : null;
  const announcement =
    version === null
      ? ""
      : restarting
        ? `Restarting to install update version ${version}`
        : `Update version ${version} is available`;

  return (
    <>
      {visible ? (
        <Button
          type="button"
          variant="outline"
          size="default"
          className="update-button w-full justify-center bg-surface font-medium text-ink hover:bg-surface-2"
          aria-label={
            restarting
              ? `Restarting to install update version ${version}`
              : `Install update version ${version}`
          }
          aria-busy={restarting ? "true" : undefined}
          disabled={locked || restarting || updatePort === null}
          onClick={() => {
            updatePort?.activate();
          }}
        >
          {restarting ? "Restarting…" : "Update available"}
        </Button>
      ) : null}
      <span
        className="update-announcement sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
    </>
  );
}

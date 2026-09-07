import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { APP_VERSION } from "../../app-version";
import type { DesktopUpdateState } from "../../update/controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

interface UpdateCopy {
  readonly action: string | null;
  readonly label: string;
  readonly announcement: string;
}

function updateCopy(state: DesktopUpdateState): UpdateCopy {
  switch (state.status) {
    case "disabled":
      return {
        action: "Updates unavailable",
        label: "Updates unavailable",
        announcement: "Updates unavailable",
      };
    case "current":
      return {
        action: "Check for updates",
        label: "Check for updates",
        announcement: "Enduragent is up to date",
      };
    case "checking":
      return {
        action: "Checking…",
        label: "Checking for updates",
        announcement: "Checking for updates",
      };
    case "downloading":
      return {
        action: "Downloading…",
        label: `Downloading update ${state.version}`,
        announcement: `Downloading update ${state.version}`,
      };
    case "downloaded":
      return {
        action: "Restart to update",
        label: `Restart to update to version ${state.version}`,
        announcement: `Restart to update to version ${state.version}`,
      };
    case "installing":
      return {
        action: "Restarting…",
        label: `Restarting to install version ${state.version}`,
        announcement: `Restarting to install version ${state.version}`,
      };
    case "failed":
      return {
        action: "Try update again",
        label: "Try update again",
        announcement:
          state.stage === "download"
            ? "Update download failed. Try again"
            : "Update check failed. Try again",
      };
    case "restart-required":
      return {
        action: null,
        label: "Restart Enduragent to resume updates",
        announcement:
          state.stage === "download"
            ? "Update download timed out. Quit and reopen Enduragent to try again."
            : "Updates could not start. Quit and reopen Enduragent to try again.",
      };
    default:
      return {
        action: "Check for updates",
        label: "Check for updates",
        announcement: "Check for updates",
      };
  }
}

export function ApplicationSection(): ReactElement {
  const update = useEnduragentStore((store) => store.settings.update);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const chatActions = useEnduragentStore((store) => store.chatActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const copy = updateCopy(update.state);
  const updateBusy =
    mutating ||
    update.actionDisabled ||
    ["disabled", "checking", "downloading", "installing"].includes(update.state.status);

  return (
    <>
      <h2 className={styles.heading}>Application</h2>
      <section className={styles.group} aria-label="Application">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Version {APP_VERSION}</div>
            <div className={styles.rowDetail}>{copy.announcement}</div>
            <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
              {copy.announcement}
            </span>
          </div>
          {update.state.status === "disabled" || copy.action === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              title={copy.label}
              aria-label={copy.label}
              disabled={updateBusy}
              onClick={() => {
                ports?.update.activate();
              }}
            >
              {copy.action}
            </Button>
          )}
        </div>
      </section>
      <h2 className={styles.heading}>Danger</h2>
      <section className={styles.group} aria-label="Danger">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={`${styles.rowTitle} ${styles.dangerTitle}`}>Reset conversation</div>
            <div className={styles.rowDetail}>
              Clears the visible conversation. Training data and saved coach memory remain.
            </div>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={chatActions === null || mutating}
            onClick={() => {
              setActiveView("chat");
              chatActions?.openNewConversation();
            }}
          >
            Reset conversation
          </Button>
        </div>
      </section>
    </>
  );
}

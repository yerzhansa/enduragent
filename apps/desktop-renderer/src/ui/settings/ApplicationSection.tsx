import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
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

function updateCopy(state: DesktopUpdateState, say: Phrasebook["say"]): UpdateCopy {
  switch (state.status) {
    case "disabled":
      return {
        action: say("settings.application.unavailable"),
        label: say("settings.application.unavailable"),
        announcement: say("settings.application.unavailable"),
      };
    case "current":
      return {
        action: say("settings.application.check"),
        label: say("settings.application.check"),
        announcement: say("settings.application.current", { product: "Enduragent" }),
      };
    case "checking":
      return {
        action: say("settings.application.checkingAction"),
        label: say("settings.application.checking"),
        announcement: say("settings.application.checking"),
      };
    case "downloading":
      return {
        action: say("settings.application.downloadingAction"),
        label: say("settings.application.downloading", { version: state.version }),
        announcement: say("settings.application.downloading", { version: state.version }),
      };
    case "downloaded":
      return {
        action: say("settings.application.restartAction"),
        label: say("settings.application.restart", { version: state.version }),
        announcement: say("settings.application.restart", { version: state.version }),
      };
    case "installing":
      return {
        action: say("settings.application.restartingAction"),
        label: say("settings.application.restarting", { version: state.version }),
        announcement: say("settings.application.restarting", { version: state.version }),
      };
    case "failed":
      return {
        action: say("settings.application.retry"),
        label: say("settings.application.retry"),
        announcement:
          state.stage === "download"
            ? say("settings.application.downloadFailed")
            : say("settings.application.checkFailed"),
      };
    case "restart-required":
      return {
        action: null,
        label: say("settings.application.restartRequired", { product: "Enduragent" }),
        announcement:
          state.stage === "download"
            ? say("settings.application.downloadTimedOut", { product: "Enduragent" })
            : say("settings.application.startFailed", { product: "Enduragent" }),
      };
    default:
      return {
        action: say("settings.application.check"),
        label: say("settings.application.check"),
        announcement: say("settings.application.check"),
      };
  }
}

export function ApplicationSection(): ReactElement {
  const { say } = usePhrasebook();
  const update = useEnduragentStore((store) => store.settings.update);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const chatActions = useEnduragentStore((store) => store.chatActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const copy = updateCopy(update.state, say);
  const updateBusy =
    mutating ||
    update.actionDisabled ||
    ["disabled", "checking", "downloading", "installing"].includes(update.state.status);

  return (
    <>
      <h2 className={styles.heading}>{say("settings.application.title")}</h2>
      <section className={styles.group} aria-label={say("settings.application.title")}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>
              {say("settings.application.version", {
                version:
                  APP_VERSION === "unknown"
                    ? say("settings.application.versionUnknown")
                    : APP_VERSION,
              })}
            </div>
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
      <h2 className={styles.heading}>{say("settings.application.danger")}</h2>
      <section className={styles.group} aria-label={say("settings.application.danger")}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={`${styles.rowTitle} ${styles.dangerTitle}`}>
              {say("settings.application.reset")}
            </div>
            <div className={styles.rowDetail}>{say("settings.application.resetDetail")}</div>
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
            {say("settings.application.reset")}
          </Button>
        </div>
      </section>
    </>
  );
}

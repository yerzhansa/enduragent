import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { APP_VERSION } from "../../app-version";
import type { DesktopUpdateState } from "../../update/controller";
import {
  formatUpdateDownloadAnnouncement,
  formatUpdateDownloadDetail,
} from "../../update/progress-format";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

type UpdateProgressBar =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "determinate"; readonly percent: number };

interface UpdateCopy {
  readonly action: string | null;
  readonly label: string;
  readonly detail: string;
  readonly announcement: string;
  readonly numericDetail?: boolean;
  readonly progressBar?: UpdateProgressBar;
}

function updateCopy(
  state: DesktopUpdateState,
  phrasebook: Pick<Phrasebook, "say" | "format">,
): UpdateCopy {
  const { say } = phrasebook;
  switch (state.status) {
    case "disabled": {
      const text = say("settings.application.unavailable");
      return { action: text, label: text, detail: text, announcement: text };
    }
    case "current": {
      const action = say("settings.application.check");
      const detail = say("settings.application.current", { product: "Enduragent" });
      return { action, label: action, detail, announcement: detail };
    }
    case "checking": {
      const detail = say("settings.application.checking");
      return {
        action: say("settings.application.checkingAction"),
        label: detail,
        detail,
        announcement: detail,
      };
    }
    case "downloading": {
      const label = say("settings.application.downloading", { version: state.version });
      if (state.progress === undefined) {
        return {
          action: say("settings.application.downloadingAction"),
          label,
          detail: label,
          announcement: label,
          progressBar: { kind: "indeterminate" },
        };
      }
      return {
        action: say("settings.application.downloadingAction"),
        label,
        detail: formatUpdateDownloadDetail(state.version, state.progress, phrasebook),
        announcement: formatUpdateDownloadAnnouncement(state.version, state.progress, phrasebook),
        numericDetail: true,
        progressBar: { kind: "determinate", percent: state.progress.percent },
      };
    }
    case "preparing": {
      const detail = say("settings.application.preparing", { version: state.version });
      return {
        action: say("settings.application.preparingAction"),
        label: detail,
        detail,
        announcement: detail,
        progressBar: { kind: "indeterminate" },
      };
    }
    case "downloaded": {
      const detail = say("settings.application.restart", { version: state.version });
      return {
        action: say("settings.application.restartAction"),
        label: detail,
        detail,
        announcement: detail,
      };
    }
    case "installing": {
      const detail = say("settings.application.restarting", { version: state.version });
      return {
        action: say("settings.application.restartingAction"),
        label: detail,
        detail,
        announcement: detail,
      };
    }
    case "failed": {
      const action = say("settings.application.retry");
      const detail =
        state.stage === "download"
          ? say("settings.application.downloadFailed")
          : say("settings.application.checkFailed");
      return { action, label: action, detail, announcement: detail };
    }
    case "restart-required": {
      const detail =
        state.stage === "download"
          ? say("settings.application.downloadTimedOut", { product: "Enduragent" })
          : say("settings.application.startFailed", { product: "Enduragent" });
      return {
        action: null,
        label: say("settings.application.restartRequired", { product: "Enduragent" }),
        detail,
        announcement: detail,
      };
    }
    default: {
      const text = say("settings.application.check");
      return { action: text, label: text, detail: text, announcement: text };
    }
  }
}

export function ApplicationSection(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const update = useEnduragentStore((store) => store.settings.update);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const chatActions = useEnduragentStore((store) => store.chatActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const copy = updateCopy(update.state, phrasebook);
  const updateBusy =
    mutating ||
    update.pendingAction !== "none" ||
    ["disabled", "checking", "downloading", "preparing", "installing"].includes(
      update.state.status,
    );
  const rowContent = (
    <>
      <div className={styles.label}>
        <div className={styles.rowTitle}>
          {say("settings.application.version", {
            version:
              APP_VERSION === "unknown" ? say("settings.application.versionUnknown") : APP_VERSION,
          })}
        </div>
        <div
          className={
            copy.numericDetail === true ? `${styles.rowDetail} tabular-nums` : styles.rowDetail
          }
        >
          {copy.detail}
        </div>
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
    </>
  );

  return (
    <>
      <h2 className={styles.heading}>{say("settings.application.title")}</h2>
      <section className={styles.group} aria-label={say("settings.application.title")}>
        {copy.progressBar === undefined ? (
          <div className={styles.row}>{rowContent}</div>
        ) : (
          <div className={`${styles.row} ${styles.rowStacked}`}>
            <div className={styles.bareRow}>{rowContent}</div>
            <div
              role="progressbar"
              aria-label={copy.label}
              aria-valuemin={copy.progressBar.kind === "determinate" ? 0 : undefined}
              aria-valuemax={copy.progressBar.kind === "determinate" ? 100 : undefined}
              aria-valuenow={
                copy.progressBar.kind === "determinate" ? copy.progressBar.percent : undefined
              }
              aria-valuetext={copy.detail}
              className={styles.updateProgressTrack}
            >
              <div
                className={
                  copy.progressBar.kind === "determinate"
                    ? styles.updateProgressFill
                    : styles.updateProgressIndeterminate
                }
                style={
                  copy.progressBar.kind === "determinate"
                    ? { width: `${copy.progressBar.percent}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}
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

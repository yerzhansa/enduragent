import type { ReactElement } from "react";
import { usePhrasebook } from "@enduragent/i18n/react";
import { PLATFORM_COPY } from "../../platform-copy";
import { useEnduragentStore } from "../../state/store";
import { AppearanceControl } from "./AppearanceControl";
import { LanguageControl } from "./LanguageControl";
import { PalettePicker } from "./PalettePicker";
import { settingsStyles as styles } from "./styles";
import { UnitsControl } from "./UnitsControl";

export function PreferencesSection(): ReactElement {
  const { say } = usePhrasebook();
  const units = useEnduragentStore((store) => store.settings.units);
  const language = useEnduragentStore((store) => store.settings.language);

  return (
    <>
      <h2 className={styles.heading}>{say("settings.preferences")}</h2>
      <section className={styles.group} aria-label={say("settings.preferences")}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>{say("settings.language.title")}</div>
            <div className={styles.rowDetail}>
              {language.status === "saving"
                ? say("settings.language.saving")
                : language.status === "unavailable"
                  ? say("settings.language.unavailable")
                  : language.value === null
                    ? say("settings.language.automaticDetail", {
                        operatingSystem: PLATFORM_COPY.operatingSystem,
                      })
                    : say("settings.language.explicitDetail")}
            </div>
          </div>
          <LanguageControl />
        </div>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>{say("settings.units.title")}</div>
            <div className={styles.rowDetail}>
              {units.status === "saving"
                ? say("settings.units.saving")
                : units.status === "unavailable"
                  ? say("settings.units.unavailable")
                  : say("settings.units.detail")}
            </div>
          </div>
          <UnitsControl />
        </div>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>{say("settings.appearance.title")}</div>
            <div className={styles.rowDetail}>
              {say("settings.appearance.detail", {
                operatingSystem: PLATFORM_COPY.operatingSystem,
              })}
            </div>
          </div>
          <AppearanceControl />
        </div>
      </section>
      <h2 className={styles.heading}>Palette</h2>
      <section className={styles.group} aria-label="Palette">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>App palette</div>
            <div className={styles.rowDetail}>
              Changes both themes immediately · Patrol is the default
            </div>
          </div>
        </div>
        <PalettePicker />
      </section>
    </>
  );
}

import type { ReactElement } from "react";
import { PLATFORM_COPY } from "../../platform-copy";
import { useEnduragentStore } from "../../state/store";
import { AppearanceControl } from "./AppearanceControl";
import { PalettePicker } from "./PalettePicker";
import { settingsStyles as styles } from "./styles";
import { UnitsControl } from "./UnitsControl";

export function PreferencesSection(): ReactElement {
  const units = useEnduragentStore((store) => store.settings.units);

  return (
    <>
      <h2 className={styles.heading}>Preferences</h2>
      <section className={styles.group} aria-label="Preferences">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Units</div>
            <div className={styles.rowDetail}>
              {units.status === "saving"
                ? "Saving units…"
                : units.status === "unavailable"
                  ? "Units preference unavailable"
                  : "Distance and body mass follow this setting. Cycling power-to-weight remains W/kg."}
            </div>
          </div>
          <UnitsControl />
        </div>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Appearance</div>
            <div className={styles.rowDetail}>
              System follows your {PLATFORM_COPY.operatingSystem} light and dark setting
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

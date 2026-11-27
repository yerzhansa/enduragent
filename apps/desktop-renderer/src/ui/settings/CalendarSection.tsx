import { usePhrasebook } from "@enduragent/i18n/react";
import { useEffect, type ReactElement } from "react";
import { useEnduragentStore } from "../../state/store";
import { SettingSwitch } from "../calendar/SettingSwitch";
import { settingsStyles as styles } from "./styles";

export function CalendarSection(): ReactElement {
  const { say } = usePhrasebook();
  const settings = useEnduragentStore((store) => store.calendarSettings);
  const actions = useEnduragentStore((store) => store.calendarSettingsActions);
  useEffect(() => {
    actions?.load();
  }, [actions]);
  const weekDelivery = settings.weekDelivery;
  const login = settings.startAtLogin;
  return (
    <>
      <h2 className={styles.heading}>{say("settings.calendar.title")}</h2>
      <section className={styles.group} aria-label={say("settings.calendar.title")}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>{say("settings.calendar.approveEachWeek")}</div>
            <div className={styles.rowDetail}>
              {weekDelivery.kind === "unavailable"
                ? say("settings.calendar.unavailable")
                : say("settings.calendar.approveEachWeekDetail")}
            </div>
          </div>
          <SettingSwitch
            label={say("settings.calendar.approveEachWeek")}
            checked={
              (weekDelivery.kind === "ready" || weekDelivery.kind === "saving") &&
              weekDelivery.value === "approve-each-week"
            }
            disabled={weekDelivery.kind !== "ready"}
            onChange={(checked) =>
              actions?.setWeekDelivery(checked ? "approve-each-week" : "send-each-week")
            }
          />
        </div>
        {login.kind === "unavailable" ? null : (
          <div className={styles.row}>
            <div className={styles.label}>
              <div className={styles.rowTitle}>{say("settings.calendar.startAtLogin")}</div>
              <div className={styles.rowDetail}>{say("settings.calendar.startAtLoginDetail")}</div>
            </div>
            <SettingSwitch
              label={say("settings.calendar.startAtLogin")}
              checked={login.enabled}
              disabled={login.kind !== "ready"}
              onChange={(checked) => actions?.setStartAtLogin(checked)}
            />
          </div>
        )}
      </section>
    </>
  );
}

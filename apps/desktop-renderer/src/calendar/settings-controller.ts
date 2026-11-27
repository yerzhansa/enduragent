import type { PlanCalendarRpcResult, PlanCalendarWeekDelivery } from "@enduragent/coach-contract";

export type WeekDeliverySetting =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: PlanCalendarWeekDelivery }
  | { readonly kind: "saving"; readonly value: PlanCalendarWeekDelivery }
  | { readonly kind: "unavailable" };

export type LoginSwitch =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly enabled: boolean }
  | { readonly kind: "saving"; readonly enabled: boolean };

export type StartAtLoginReply =
  | { readonly kind: "unavailable" }
  | { readonly kind: "known"; readonly enabled: boolean };

export interface CalendarSettingsState {
  readonly weekDelivery: WeekDeliverySetting;
  readonly startAtLogin: LoginSwitch;
}

export const CALENDAR_SETTINGS_START: CalendarSettingsState = {
  weekDelivery: { kind: "loading" },
  startAtLogin: { kind: "unavailable" },
};

export interface CalendarSettingsController {
  load(): Promise<void>;
  setWeekDelivery(value: PlanCalendarWeekDelivery): Promise<void>;
  setStartAtLogin(enabled: boolean): Promise<void>;
}

function loginOf(reply: StartAtLoginReply): LoginSwitch {
  return reply.kind === "known" ? { kind: "ready", enabled: reply.enabled } : reply;
}

export function createCalendarSettingsController(deps: {
  readSettings(): Promise<PlanCalendarRpcResult>;
  saveSettings(value: PlanCalendarWeekDelivery): Promise<PlanCalendarRpcResult>;
  readStartAtLogin(): Promise<StartAtLoginReply>;
  setStartAtLogin(enabled: boolean): Promise<StartAtLoginReply>;
  publish(state: CalendarSettingsState): void;
}): CalendarSettingsController {
  let state: CalendarSettingsState = CALENDAR_SETTINGS_START;
  const publish = (next: Partial<CalendarSettingsState>): void => {
    state = { ...state, ...next };
    deps.publish(state);
  };
  const weekDeliveryOf = (result: PlanCalendarRpcResult): WeekDeliverySetting =>
    result.status === "settings"
      ? { kind: "ready", value: result.weekDelivery }
      : { kind: "unavailable" };
  return {
    async load() {
      const [settings, login] = await Promise.allSettled([
        deps.readSettings(),
        deps.readStartAtLogin(),
      ]);
      publish({
        weekDelivery:
          state.weekDelivery.kind === "saving"
            ? state.weekDelivery
            : settings.status === "fulfilled"
              ? weekDeliveryOf(settings.value)
              : { kind: "unavailable" },
        startAtLogin:
          state.startAtLogin.kind === "saving"
            ? state.startAtLogin
            : login.status === "fulfilled"
              ? loginOf(login.value)
              : { kind: "unavailable" },
      });
    },
    async setWeekDelivery(value) {
      const current = state.weekDelivery;
      if (current.kind !== "ready" || current.value === value) return;
      publish({ weekDelivery: { kind: "saving", value } });
      try {
        publish({ weekDelivery: weekDeliveryOf(await deps.saveSettings(value)) });
      } catch {
        publish({ weekDelivery: current });
      }
    },
    async setStartAtLogin(enabled) {
      const current = state.startAtLogin;
      if (current.kind !== "ready") return;
      publish({ startAtLogin: { kind: "saving", enabled } });
      try {
        publish({ startAtLogin: loginOf(await deps.setStartAtLogin(enabled)) });
      } catch {
        publish({ startAtLogin: current });
      }
    },
  };
}

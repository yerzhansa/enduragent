const PLAN_RETURN_STORAGE_KEY = "enduragent.plan.return-on-launch";

export function readPlanReturnOnLaunch(): boolean {
  try {
    return window.localStorage.getItem(PLAN_RETURN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writePlanReturnOnLaunch(enabled: boolean): boolean {
  try {
    if (enabled) window.localStorage.setItem(PLAN_RETURN_STORAGE_KEY, "true");
    else window.localStorage.removeItem(PLAN_RETURN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

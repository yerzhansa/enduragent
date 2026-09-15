export const STRAVA_RESTRICTION_CARD_ID = "strava-restricted-activities";
export const STRAVA_HELP_HREF = "https://enduragent.icu/help/strava";

let focusRequested = false;

export function requestTrainingRestrictionFocus(): void {
  focusRequested = true;
}

export function focusTrainingRestrictionIfPresent(element: HTMLElement | null): void {
  if (!focusRequested || element === null || !element.isConnected || element.hidden) return;
  focusRequested = false;
  element.focus();
}

export function takeTrainingRestrictionFocusRequest(): boolean {
  const requested = focusRequested;
  focusRequested = false;
  return requested;
}

export function clearTrainingRestrictionFocusRequest(): void {
  focusRequested = false;
}

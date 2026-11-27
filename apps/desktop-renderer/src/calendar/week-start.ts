import { rendererPlatformProjection } from "../platform-copy";
import { nextWeekStart, type FirstDayOfWeek } from "./dates";

export function regionWeekStart(
  isoDate: string,
  firstDay: FirstDayOfWeek = rendererPlatformProjection().firstDayOfWeek,
): string {
  const text = String(nextWeekStart(Number(isoDate.replaceAll("-", "")), firstDay));
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

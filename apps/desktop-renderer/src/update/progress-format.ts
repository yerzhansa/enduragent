import type { Phrasebook } from "@enduragent/i18n/messages";
import type { DesktopUpdateDownloadProgress } from "./controller";

const BYTES_PER_MEGABYTE = 1_048_576;
const ANNOUNCEMENT_STEP_PERCENT = 25;

function formatDecimal(value: number, format: Phrasebook["format"]): string {
  return format.number(Number(value.toFixed(1)), {
    useGrouping: false,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function formatUpdateDownloadDetail(
  version: string,
  progress: DesktopUpdateDownloadProgress,
  phrasebook: Pick<Phrasebook, "say" | "format">,
): string {
  const { say, format } = phrasebook;
  const percent = format.number(progress.percent, {
    useGrouping: false,
    maximumFractionDigits: 0,
  });
  const transferred = formatDecimal(progress.transferredBytes / BYTES_PER_MEGABYTE, format);
  const total = formatDecimal(progress.totalBytes / BYTES_PER_MEGABYTE, format);
  const speedMegabytes = progress.bytesPerSecond / BYTES_PER_MEGABYTE;
  if (Math.round(speedMegabytes * 10) >= 1) {
    return say("settings.application.downloadingProgressWithSpeed", {
      version,
      percent,
      transferred,
      total,
      speed: formatDecimal(speedMegabytes, format),
    });
  }
  return say("settings.application.downloadingProgress", {
    version,
    percent,
    transferred,
    total,
  });
}

export function formatUpdateDownloadAnnouncement(
  version: string,
  progress: DesktopUpdateDownloadProgress | undefined,
  phrasebook: Pick<Phrasebook, "say" | "format">,
): string {
  if (progress === undefined) {
    return phrasebook.say("settings.application.downloading", { version });
  }
  const milestone =
    Math.floor(progress.percent / ANNOUNCEMENT_STEP_PERCENT) * ANNOUNCEMENT_STEP_PERCENT;
  if (milestone < ANNOUNCEMENT_STEP_PERCENT) {
    return phrasebook.say("settings.application.downloading", { version });
  }
  return phrasebook.say("settings.application.downloadingMilestone", {
    version,
    percent: phrasebook.format.number(milestone, {
      useGrouping: false,
      maximumFractionDigits: 0,
    }),
  });
}

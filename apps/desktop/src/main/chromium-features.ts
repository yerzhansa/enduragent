import type { App } from "electron";

export function disableChromiumMediaSessionIntegration(app: Pick<App, "commandLine">): void {
  const alreadyDisabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [alreadyDisabled, "MediaSessionService", "HardwareMediaKeyHandling"]
      .filter((feature) => feature.length > 0)
      .join(","),
  );
}

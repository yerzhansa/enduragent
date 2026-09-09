export function traceDesktopStartupStage(stage: string): void {
  if (
    process.env.ENDURAGENT_ACCEPTANCE_HIDDEN === "1" ||
    process.env.ENDURAGENT_STARTUP_TRACE === "1"
  ) {
    process.stderr.write(`desktop-startup-stage ${stage}\n`);
  }
}

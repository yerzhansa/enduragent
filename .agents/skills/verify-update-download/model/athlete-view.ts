// Plain-language view for AthleteUpdateFlow.tla when read with /statechart.

interface Vars {
  readonly phase: string;
  readonly wedged: boolean;
}

export const title = "Desktop update and download flow (athlete view)";

export const state = (v: Vars): string => {
  switch (v.phase) {
    case "idle":
      return "Ready to check";
    case "checking":
      return "Checking for updates";
    case "current":
      return "Up to date";
    case "downloading":
      return "Downloading update";
    case "preparing":
      return "Preparing update on macOS";
    case "downloaded":
      return "Update ready to install";
    case "installing":
      return "Closing app to install";
    case "installed":
      return "Installer launched";
    case "relaunching":
      return "Relaunching current version";
    case "failed":
      return v.wedged ? "Update failed (Retry stuck)" : "Update failed";
    case "restart-required":
      return "Quit and reopen required";
    case "stranded":
      return "App exited without updating";
    default:
      return v.phase;
  }
};

export const group = (v: Vars): string => {
  switch (v.phase) {
    case "idle":
    case "current":
      return "ready";
    case "checking":
    case "downloading":
    case "preparing":
      return "active";
    case "downloaded":
    case "installing":
      return "install";
    case "installed":
    case "relaunching":
      return "done";
    case "failed":
    case "restart-required":
    case "stranded":
      return "problem";
    default:
      return "ready";
  }
};

export const colors: Record<string, string> = {
  ready: "tan",
  active: "blue",
  install: "yellow",
  done: "teal",
  problem: "pink",
};

export const step = (action: string, from: Vars, to: Vars): string => {
  switch (action) {
    case "StartCheck":
      return from.phase === "idle" ? "check starts" : "you check again";
    case "RetryCheck":
      return "you click Try again";
    case "CheckCurrent":
      return "no newer version";
    case "CheckFindsUpdate":
      return "newer version found";
    case "CheckFails":
      return "check fails or version refused";
    case "CheckErrorsBeforeSettle":
      return "error arrives while check is still pending";
    case "CheckTimesOutOrLoadFails":
      return "check times out or updater fails to load";
    case "ZipDownloadFinishes":
      return "download finishes";
    case "DownloadFails":
      return "download fails";
    case "DownloadStallsOrTimesOut":
      return "download stalls or hits time limit";
    case "NativeVerificationFinishes":
      return "macOS verifies update";
    case "NativeVerificationFails":
      return "macOS rejects update";
    case "NativeVerificationTimesOut":
      return "macOS verification times out";
    case "PreparedUpdateInvalidated":
      return "prepared update becomes invalid";
    case "ClickRestartToUpdate":
      return "you click Restart to update";
    case "InstallHandoffSucceeds":
      return "app drains and starts installer";
    case "InstallHandoffFails":
      return to.phase === "relaunching"
        ? "handoff fails; app relaunches"
        : "drain or install handoff fails";
    case "Done":
      return "done";
    default:
      return action;
  }
};

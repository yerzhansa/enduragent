import { msg, type Message } from "@enduragent/i18n";
import type {
  CoachOperationProgressNotificationEnvelope,
  ImportFilesRpcResult,
} from "@enduragent/coach-contract";
import { validateImportPaths } from "./onboarding/bridge";

export type RideImportOwner = "onboarding" | "resident";

type RideImportResult = ImportFilesRpcResult;

export type RideImportState =
  | {
      readonly status: "idle";
      readonly owner: null;
      readonly progress: null;
      readonly result: null;
    }
  | {
      readonly status: "running";
      readonly owner: RideImportOwner;
      readonly stage: "choosing" | "importing";
      readonly progress: CoachOperationProgressNotificationEnvelope | null;
      readonly result: null;
    }
  | {
      readonly status: "succeeded";
      readonly owner: RideImportOwner;
      readonly progress: null;
      readonly result: RideImportResult;
    }
  | {
      readonly status: "failed";
      readonly owner: RideImportOwner;
      readonly progress: null;
      readonly result: RideImportResult | null;
    };

export type RideImportAttempt = "busy" | "cancelled" | "failed" | "succeeded";

export interface RideImportTransport {
  chooseImportFiles(): Promise<readonly string[]>;
  importFiles(
    paths: readonly string[],
    onProgress: (event: CoachOperationProgressNotificationEnvelope) => void,
  ): Promise<ImportFilesRpcResult>;
}

export interface RideImportController {
  state(): RideImportState;
  isBusy(): boolean;
  importedFileCount(): number;
  subscribe(listener: (state: RideImportState) => void): () => void;
  chooseAndImport(owner: RideImportOwner): Promise<RideImportAttempt>;
  importPaths(owner: RideImportOwner, paths: readonly string[]): Promise<RideImportAttempt>;
}

const IDLE_STATE: RideImportState = {
  status: "idle",
  owner: null,
  progress: null,
  result: null,
};

export function createRideImportController(transport: RideImportTransport): RideImportController {
  let state = IDLE_STATE;
  let attempt = 0;
  let importedFileCount = 0;
  const listeners = new Set<(state: RideImportState) => void>();

  const publish = (next: RideImportState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const begin = (owner: RideImportOwner, stage: "choosing" | "importing"): number | null => {
    if (state.status === "running") return null;
    const currentAttempt = ++attempt;
    publish({
      status: "running",
      owner,
      stage,
      progress: null,
      result: null,
    });
    return currentAttempt;
  };

  const fail = (owner: RideImportOwner, result: RideImportResult | null): RideImportAttempt => {
    publish({ status: "failed", owner, progress: null, result });
    return "failed";
  };

  const execute = async (
    owner: RideImportOwner,
    paths: readonly string[],
    currentAttempt: number,
  ): Promise<RideImportAttempt> => {
    try {
      const validatedPaths = validateImportPaths(paths);
      publish({
        status: "running",
        owner,
        stage: "importing",
        progress: null,
        result: null,
      });
      const result = await transport.importFiles(validatedPaths, (progress) => {
        if (attempt !== currentAttempt || state.status !== "running") return;
        publish({
          status: "running",
          owner,
          stage: "importing",
          progress,
          result: null,
        });
      });
      if (
        result.files.imported <= 0 &&
        !(result.files.total === 0 && result.publication.status === "available")
      ) {
        return fail(owner, result);
      }
      importedFileCount += result.files.imported;
      publish({
        status: "succeeded",
        owner,
        progress: null,
        result,
      });
      return "succeeded";
    } catch {
      return fail(owner, null);
    }
  };

  return {
    state: () => state,
    isBusy: () => state.status === "running",
    importedFileCount: () => importedFileCount,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async chooseAndImport(owner) {
      const currentAttempt = begin(owner, "choosing");
      if (currentAttempt === null) return "busy";
      try {
        const paths = await transport.chooseImportFiles();
        if (paths.length === 0) {
          publish(IDLE_STATE);
          return "cancelled";
        }
        return execute(owner, paths, currentAttempt);
      } catch {
        return fail(owner, null);
      }
    },
    async importPaths(owner, paths) {
      const currentAttempt = begin(owner, "importing");
      if (currentAttempt === null) return "busy";
      return execute(owner, paths, currentAttempt);
    },
  };
}

function rideFileCount(count: number): string {
  return `${count} ride file${count === 1 ? "" : "s"}`;
}

export function rideImportStatusCopy(state: RideImportState): string {
  if (state.status === "idle") return "";
  if (state.status === "running") {
    return state.stage === "choosing"
      ? "Waiting for ride file selection…"
      : "Importing ride files…";
  }
  if (state.result === null) {
    return "Local library import failed. The result could not be confirmed; check the library before trying again.";
  }
  const counts = `${rideFileCount(state.result.files.imported)} imported. ${rideFileCount(state.result.files.quarantined)} quarantined.`;
  if (state.status === "failed") {
    return `Local library import failed. ${counts} No new ride files are available for coaching.`;
  }
  const availability =
    state.result.publication.status === "available"
      ? "Coaching access to activities and streams is available."
      : "Coaching access to activities and streams is temporarily unavailable; retry the import.";
  return `Local library import: ${counts} ${availability}`;
}

export function rideFileCountMessage(count: number, formattedCount: string): Message {
  const vars = { count, formattedCount };
  return msg("setup.import.fileCount", { ...vars, count: count });
}

export function rideImportStatusMessage(
  state: RideImportState,
  counts: { readonly imported: string; readonly quarantined: string },
): Message | null {
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return state.stage === "choosing"
      ? msg("setup.import.choosing")
      : msg("setup.import.importing");
  }
  if (state.result === null) return msg("setup.import.unconfirmed");
  if (state.status === "failed") return msg("setup.import.failed", counts);
  return state.result.publication.status === "available"
    ? msg("setup.import.available", counts)
    : msg("setup.import.unavailable", counts);
}

interface DroppedRideImportRouterOptions {
  readonly subscribe: (listener: (paths: readonly string[]) => void) => () => void;
  readonly onboarding: {
    ownsDroppedImportFiles(): boolean;
    importDroppedFiles(paths: readonly string[]): void;
  };
  readonly resident: {
    importDroppedFiles(paths: readonly string[]): void;
  };
}

export function subscribeToDroppedRideImports(options: DroppedRideImportRouterOptions): () => void {
  return options.subscribe((paths) => {
    if (options.onboarding.ownsDroppedImportFiles()) {
      options.onboarding.importDroppedFiles(paths);
    } else {
      options.resident.importDroppedFiles(paths);
    }
  });
}

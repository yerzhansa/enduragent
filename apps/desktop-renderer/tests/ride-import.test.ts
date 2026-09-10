import { createPhrasebook } from "@enduragent/i18n/messages";
import type {
  CoachOperationProgressNotificationEnvelope,
  ImportFilesRpcResult,
} from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createRideImportController,
  rideImportStatusCopy,
  rideFileCountMessage,
  rideImportStatusMessage,
  subscribeToDroppedRideImports,
  type RideImportState,
  type RideImportTransport,
} from "../src/ride-import";

function result(
  imported: number,
  quarantined: number,
  rawFilesInserted = imported,
  publicationStatus: ImportFilesRpcResult["publication"]["status"] = "available",
): ImportFilesRpcResult {
  return {
    schemaVersion: 2,
    files: { total: imported + quarantined, imported, quarantined },
    changes: {
      rawFilesInserted,
      sourceRecordsInserted: imported,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: {
      scope: "activities-and-streams",
      status: publicationStatus,
    },
  };
}

function progress(phase: "started" | "completed"): CoachOperationProgressNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.operationProgress",
    params: {
      requestId: 7,
      requestMethod: "importFiles",
      event: { phase, completed: phase === "started" ? 0 : 1, total: 1 },
    },
  };
}

function transport(overrides: Partial<RideImportTransport> = {}): RideImportTransport & {
  chooseImportFiles: ReturnType<typeof vi.fn<RideImportTransport["chooseImportFiles"]>>;
  importFiles: ReturnType<typeof vi.fn<RideImportTransport["importFiles"]>>;
} {
  return {
    chooseImportFiles: vi.fn(async () => []),
    importFiles: vi.fn(async () => result(1, 0)),
    ...overrides,
  } as RideImportTransport & {
    chooseImportFiles: ReturnType<typeof vi.fn<RideImportTransport["chooseImportFiles"]>>;
    importFiles: ReturnType<typeof vi.fn<RideImportTransport["importFiles"]>>;
  };
}

describe("ride import controller", () => {
  it("uses the picker, validates picker and drop paths, and dispatches each valid attempt once", async () => {
    const bridge = transport({
      chooseImportFiles: vi
        .fn<RideImportTransport["chooseImportFiles"]>()
        .mockResolvedValueOnce(["/synthetic/picked.FIT"])
        .mockResolvedValueOnce(["/synthetic/not-a-ride.zip"]),
      importFiles: vi.fn(async () => result(1, 0)),
    });
    const imports = createRideImportController(bridge);

    await expect(imports.chooseAndImport("resident")).resolves.toBe("succeeded");
    await expect(imports.importPaths("onboarding", ["/synthetic/dropped.tcx"])).resolves.toBe(
      "succeeded",
    );
    await expect(imports.importPaths("resident", ["relative.gpx"])).resolves.toBe("failed");
    await expect(imports.chooseAndImport("resident")).resolves.toBe("failed");

    expect(bridge.chooseImportFiles).toHaveBeenCalledTimes(2);
    expect(bridge.importFiles).toHaveBeenCalledTimes(2);
    expect(bridge.importFiles.mock.calls.map(([paths]) => paths)).toEqual([
      ["/synthetic/picked.FIT"],
      ["/synthetic/dropped.tcx"],
    ]);
    expect(imports.state()).toEqual({
      status: "failed",
      owner: "resident",
      progress: null,
      result: null,
    });
  });

  it("prevents picker and drop attempts from overlapping one in-flight RPC", async () => {
    let finish!: (value: ImportFilesRpcResult) => void;
    const bridge = transport({
      chooseImportFiles: vi.fn(async () => ["/synthetic/second.fit"]),
      importFiles: vi.fn<RideImportTransport["importFiles"]>(
        () =>
          new Promise<ImportFilesRpcResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const imports = createRideImportController(bridge);

    const first = imports.importPaths("resident", ["/synthetic/first.fit"]);
    await expect(imports.chooseAndImport("resident")).resolves.toBe("busy");
    await expect(imports.importPaths("onboarding", ["/synthetic/dropped.fit"])).resolves.toBe(
      "busy",
    );

    expect(bridge.chooseImportFiles).not.toHaveBeenCalled();
    expect(bridge.importFiles).toHaveBeenCalledOnce();
    finish(result(1, 0));
    await expect(first).resolves.toBe("succeeded");
  });

  it("uses returned partial and zero-import counts, retaining prior success without stale state", async () => {
    const bridge = transport();
    bridge.importFiles
      .mockImplementationOnce(async (_paths, onProgress) => {
        onProgress(progress("completed"));
        return result(2, 1);
      })
      .mockResolvedValueOnce(result(1, 0, 0))
      .mockImplementationOnce(async (_paths, onProgress) => {
        onProgress(progress("started"));
        return result(0, 3);
      })
      .mockRejectedValueOnce(new TypeError());
    const imports = createRideImportController(bridge);
    const states: RideImportState[] = [];
    imports.subscribe((state) => states.push(state));

    await expect(imports.importPaths("resident", ["/synthetic/archive.fit"])).resolves.toBe(
      "succeeded",
    );
    expect(rideImportStatusCopy(imports.state())).toBe(
      "Local library import: 2 ride files imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );
    expect(imports.importedFileCount()).toBe(2);

    await expect(imports.importPaths("resident", ["/synthetic/repeated.fit"])).resolves.toBe(
      "succeeded",
    );
    expect(rideImportStatusCopy(imports.state())).toBe(
      "Local library import: 1 ride file imported. 0 ride files quarantined. Coaching access to activities and streams is available.",
    );
    expect(imports.importedFileCount()).toBe(3);

    const beforeZeroImport = states.length;
    await expect(imports.importPaths("resident", ["/synthetic/quarantined.fit"])).resolves.toBe(
      "failed",
    );
    expect(states[beforeZeroImport]).toMatchObject({
      status: "running",
      progress: null,
      result: null,
    });
    expect(imports.state()).toEqual({
      status: "failed",
      owner: "resident",
      progress: null,
      result: result(0, 3),
    });
    expect(rideImportStatusCopy(imports.state())).toBe(
      "Local library import failed. 0 ride files imported. 3 ride files quarantined. No new ride files are available for coaching.",
    );
    expect(rideImportStatusCopy(imports.state())).not.toContain(
      "Coaching access to activities and streams is available.",
    );
    expect(imports.importedFileCount()).toBe(3);

    await expect(imports.importPaths("resident", ["/synthetic/rejected.fit"])).resolves.toBe(
      "failed",
    );
    expect(imports.state()).toEqual({
      status: "failed",
      owner: "resident",
      progress: null,
      result: null,
    });
    const failureCopy = rideImportStatusCopy(imports.state());
    expect(failureCopy).toBe(
      "Local library import failed. The result could not be confirmed; check the library before trying again.",
    );
    expect(failureCopy).not.toContain("Import completed");
    expect(
      states.filter((state) => state.status === "failed").every((state) => state.progress === null),
    ).toBe(true);
  });

  it("keeps durable ingestion across an idempotent publication retry", async () => {
    const bridge = transport();
    bridge.importFiles
      .mockResolvedValueOnce(result(1, 0, 1, "retryable-failure"))
      .mockResolvedValueOnce(result(0, 0, 0, "available"));
    const imports = createRideImportController(bridge);

    await expect(imports.importPaths("resident", ["/synthetic/retry.fit"])).resolves.toBe(
      "succeeded",
    );
    expect(imports.importedFileCount()).toBe(1);
    expect(imports.state()).toMatchObject({
      status: "succeeded",
      result: {
        files: { total: 1, imported: 1, quarantined: 0 },
        publication: {
          scope: "activities-and-streams",
          status: "retryable-failure",
        },
      },
    });
    expect(rideImportStatusCopy(imports.state())).toBe(
      "Local library import: 1 ride file imported. 0 ride files quarantined. Coaching access to activities and streams is temporarily unavailable; retry the import.",
    );

    await expect(imports.importPaths("resident", ["/synthetic/retry.fit"])).resolves.toBe(
      "succeeded",
    );
    expect(imports.importedFileCount()).toBe(1);
    expect(imports.state()).toMatchObject({
      status: "succeeded",
      result: {
        files: { total: 0, imported: 0, quarantined: 0 },
        publication: {
          scope: "activities-and-streams",
          status: "available",
        },
      },
    });
    expect(rideImportStatusCopy(imports.state())).toBe(
      "Local library import: 0 ride files imported. 0 ride files quarantined. Coaching access to activities and streams is available.",
    );
  });
});

describe("dropped ride import routing", () => {
  it("creates one disposable subscription and selects the current wizard or resident owner", () => {
    let listener: ((paths: readonly string[]) => void) | undefined;
    const dispose = vi.fn();
    const subscribe = vi.fn((next: (paths: readonly string[]) => void) => {
      listener = next;
      return dispose;
    });
    let wizardOwnsDrop = true;
    const onboarding = {
      ownsDroppedImportFiles: vi.fn(() => wizardOwnsDrop),
      importDroppedFiles: vi.fn(),
    };
    const resident = { importDroppedFiles: vi.fn() };

    const disposeRouter = subscribeToDroppedRideImports({
      subscribe,
      onboarding,
      resident,
    });
    expect(subscribe).toHaveBeenCalledOnce();

    listener?.(["/synthetic/wizard.fit"]);
    expect(onboarding.importDroppedFiles).toHaveBeenCalledWith(["/synthetic/wizard.fit"]);
    expect(resident.importDroppedFiles).not.toHaveBeenCalled();

    wizardOwnsDrop = false;
    listener?.(["/synthetic/resident.gpx"]);
    expect(resident.importDroppedFiles).toHaveBeenCalledWith(["/synthetic/resident.gpx"]);
    expect(onboarding.importDroppedFiles).toHaveBeenCalledOnce();

    disposeRouter();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("setup ride import messages", () => {
  it("preserves the existing English for every status and both count forms", async () => {
    const { say, format } = await createPhrasebook({ tag: "en", locale: "en-US" });
    const idle: RideImportState = { status: "idle", owner: null, progress: null, result: null };
    const states: RideImportState[] = [
      idle,
      { status: "running", owner: "onboarding", stage: "choosing", progress: null, result: null },
      { status: "running", owner: "onboarding", stage: "importing", progress: null, result: null },
      { status: "failed", owner: "onboarding", progress: null, result: null },
      ...[0, 1, 2, 1000].flatMap((imported): RideImportState[] =>
        [0, 1, 2].flatMap((quarantined): RideImportState[] => [
          {
            status: "failed",
            owner: "onboarding",
            progress: null,
            result: result(imported, quarantined),
          },
          {
            status: "succeeded",
            owner: "onboarding",
            progress: null,
            result: result(imported, quarantined),
          },
          {
            status: "succeeded",
            owner: "onboarding",
            progress: null,
            result: result(imported, quarantined, imported, "retryable-failure"),
          },
        ]),
      ),
    ];
    for (const state of states) {
      const imported = state.result?.files.imported ?? 0;
      const quarantined = state.result?.files.quarantined ?? 0;
      const message = rideImportStatusMessage(state, {
        imported: say(
          rideFileCountMessage(imported, format.number(imported, { useGrouping: false })),
        ),
        quarantined: say(
          rideFileCountMessage(quarantined, format.number(quarantined, { useGrouping: false })),
        ),
      });
      expect(message === null ? "" : say(message)).toBe(rideImportStatusCopy(state));
    }
  });
});

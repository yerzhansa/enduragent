import type { ImportFilesRpcResult } from "@enduragent/coach-contract";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRideImportController,
  type RideImportOwner,
  type RideImportState,
  type RideImportTransport,
} from "../src/ride-import";
import { createRideImportAdapter } from "../src/state/adapters/ride-import";
import { IDLE_RIDE_IMPORT } from "../src/state/ride-import-slice";
import { useEnduragentStore } from "../src/state/store";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { TrainingView } from "../src/ui/training/TrainingView";
import { pinDefaultLocale } from "./intl";

const PATHS = ["/rides/tuesday.fit"] as const;

function importResult(imported: number, quarantined = 0): ImportFilesRpcResult {
  return {
    schemaVersion: 2,
    files: { total: imported + quarantined, imported, quarantined },
    changes: {
      rawFilesInserted: imported,
      sourceRecordsInserted: imported,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
  };
}

function harness(
  options: {
    readonly importFiles?: RideImportTransport["importFiles"];
    readonly onSucceeded?: () => void;
  } = {},
) {
  const chooseImportFiles = vi.fn<RideImportTransport["chooseImportFiles"]>(async () => [...PATHS]);
  const importFiles = vi.fn<RideImportTransport["importFiles"]>(
    options.importFiles ?? (async () => importResult(1)),
  );
  const controller = createRideImportController({
    chooseImportFiles,
    importFiles,
  });
  const owners: (RideImportOwner | null)[] = [];
  const published: RideImportState[] = [];
  const adapter = createRideImportAdapter({
    imports: controller,
    ...(options.onSucceeded === undefined ? {} : { onSucceeded: options.onSucceeded }),
    publish: (next) => {
      published.push(next);
      owners.push(next.owner);
      useEnduragentStore.getState().setRideImport(next);
    },
  });
  useEnduragentStore.getState().bindRideImportActions(adapter.port);
  return {
    adapter,
    chooseImportFiles,
    controller,
    importFiles,
    owners,
    published,
  };
}

function status(): HTMLElement {
  const element = document.querySelector(".ride-import-status");
  if (!(element instanceof HTMLElement)) throw new TypeError("ride import status missing");
  return element;
}

beforeEach(() => {
  pinDefaultLocale("en-US");
  useEnduragentStore.setState({
    activeView: "training",
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useEnduragentStore.setState({
    activeView: "chat",
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
  });
});

describe("resident ride import glue", () => {
  it("refreshes Training after a file-only onboarding import succeeds", async () => {
    const onSucceeded = vi.fn(() => {
      useEnduragentStore.getState().setTraining({
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-18T12:00:00.000Z",
          lastSynced: null,
          freshness: "fresh",
          degraded: false,
        },
        trainingContext: {
          performanceProgress: { kind: "unavailable", reason: "not-synced" },
          recentRides: {
            kind: "computed",
            asOf: "1998-07-18T12:00:00.000Z",
            windowDays: 28,
            items: [
              {
                id: "a".repeat(64),
                subSport: "road",
                startEpochSeconds: 900_000_000,
                timezoneOffsetSeconds: 0,
                localDate: "1998-07-09",
                elapsedSeconds: 3_700,
                movingSeconds: 3_600,
                distanceMeters: 40_000,
              },
            ],
          },
          trainingHistory: {
            kind: "computed",
            asOf: "1998-07-18T12:00:00.000Z",
            calendarTimeZone: "UTC",
            displayMode: "last-recorded",
            coverage: {
              kind: "sparse",
              latestKnownRideDate: "1998-07-09",
              latestImportAt: "1998-07-18T12:00:00.000Z",
            },
            anchorWeek: {
              id: "anchor",
              window: { start: "1998-07-06", end: "1998-07-12" },
              calendarState: "closed",
              coverage: {
                kind: "incomplete",
                recordedThrough: "1998-07-09",
                reason: "sparse-imports",
              },
              totals: {
                rideCount: {
                  kind: "partial",
                  value: 1,
                  reason: "incomplete-coverage",
                },
                ridingSeconds: {
                  kind: "partial",
                  value: 3_600,
                  reason: "incomplete-coverage",
                },
                distanceMeters: {
                  kind: "partial",
                  value: 40_000,
                  reason: "incomplete-coverage",
                },
                load: { kind: "unavailable", reason: "no-recorded-value" },
              },
              rides: {
                count: { kind: "exact", value: 1 },
                items: [
                  {
                    id: "a".repeat(64),
                    title: null,
                    subSport: "road",
                    startEpochSeconds: 900_000_000,
                    timezoneOffsetSeconds: 0,
                    localDate: "1998-07-09",
                    ridingSeconds: 3_600,
                    ridingTimeBasis: "moving",
                    elapsedSeconds: 3_700,
                    distanceMeters: 40_000,
                    load: null,
                    averagePowerWatts: null,
                    averageHeartRateBpm: null,
                    perceivedExertion: null,
                    energyKilojoules: null,
                  },
                ],
                truncated: false,
              },
              trend: { kind: "unavailable", reason: "limited-history" },
              callout: null,
            },
            previousWeek: null,
          },
          anchorZones: { kind: "unknown", reason: "not-synced" },
          cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
          plan: { kind: "unknown", reason: "no-plan" },
          adherence: { kind: "unknown", reason: "insufficient-data" },
          wellnessTrend: { kind: "unknown", reason: "no-wellness" },
        },
      });
    });
    const subject = harness({ onSucceeded });
    useEnduragentStore.getState().setTraining({
      ...EMPTY_TRAINING_SURFACE,
      status: "unavailable",
    });
    render(<TrainingView />);

    expect(screen.getByText("Training history is not available yet.")).toBeInTheDocument();
    await act(async () => {
      await subject.controller.importPaths("onboarding", [...PATHS]);
    });

    expect(onSucceeded).toHaveBeenCalledOnce();
    expect(screen.queryByText("Training history is not available yet.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open ride review: Road ride, Jul 9, 1998 · 4:00 PM",
      }),
    ).toBeInTheDocument();
  });

  it("publishes the controller state into the store from the first subscription", () => {
    const subject = harness();

    expect(subject.published).toEqual([IDLE_RIDE_IMPORT]);
    expect(useEnduragentStore.getState().rideImport).toEqual(IDLE_RIDE_IMPORT);
  });

  it("walks the picker, import and success stages onto the training page", async () => {
    const subject = harness();
    const user = userEvent.setup();
    render(<TrainingView />);

    await user.click(screen.getByRole("button", { name: "Import ride files" }));

    expect(subject.chooseImportFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(subject.importFiles).toHaveBeenCalledTimes(1);
    });
    expect(subject.importFiles.mock.calls[0]?.[0]).toEqual([...PATHS]);
    await waitFor(() => {
      expect(status()).toHaveAttribute("data-state", "succeeded");
    });
    expect(status()).toHaveTextContent(
      "Local library import: 1 ride file imported. 0 ride files quarantined.",
    );
    expect(subject.owners).toEqual([null, "resident", "resident", "resident"]);
    expect(subject.published.map((state) => state.status)).toEqual([
      "idle",
      "running",
      "running",
      "succeeded",
    ]);
  });

  it("claims the import for the resident owner even while onboarding suppresses the status", async () => {
    const subject = harness();
    render(<TrainingView />);

    await act(async () => {
      await subject.controller.importPaths("onboarding", [...PATHS]);
    });
    expect(subject.published.at(-1)?.owner).toBe("onboarding");

    await act(async () => {
      subject.adapter.port.choose();
      await vi.waitFor(() => expect(subject.importFiles).toHaveBeenCalledTimes(2));
    });
    expect(subject.published.at(-1)).toMatchObject({
      status: "succeeded",
      owner: "resident",
    });
  });

  it("reports a failed import through the same publication path", async () => {
    const subject = harness({ importFiles: async () => importResult(0, 1) });
    const user = userEvent.setup();
    render(<TrainingView />);

    await user.click(screen.getByRole("button", { name: "Import ride files" }));

    await waitFor(() => {
      expect(status()).toHaveAttribute("data-state", "failed");
    });
    expect(subject.published.at(-1)?.owner).toBe("resident");
    expect(status()).toHaveTextContent("Local library import failed.");
  });

  it("stops publishing and stops reaching the controller once the adapter is disposed", async () => {
    const subject = harness();
    render(<TrainingView />);

    subject.adapter.dispose();
    const published = subject.published.length;
    subject.adapter.port.choose();
    await act(async () => {
      await subject.controller.importPaths("resident", [...PATHS]);
    });

    expect(subject.chooseImportFiles).not.toHaveBeenCalled();
    expect(subject.published).toHaveLength(published);
    expect(useEnduragentStore.getState().rideImport).toEqual(IDLE_RIDE_IMPORT);
  });

  it("keeps the import action inert until the actions are bound", async () => {
    const user = userEvent.setup();
    const subject = harness();
    act(() => {
      useEnduragentStore.getState().bindRideImportActions(null);
    });
    render(<TrainingView />);

    const action = screen.getByRole("button", { name: "Import ride files" });
    expect(action).toBeDisabled();
    await user.click(action);
    expect(subject.chooseImportFiles).not.toHaveBeenCalled();

    act(() => {
      useEnduragentStore.getState().bindRideImportActions(subject.adapter.port);
    });
    expect(screen.getByRole("button", { name: "Import ride files" })).toBeEnabled();
  });
});

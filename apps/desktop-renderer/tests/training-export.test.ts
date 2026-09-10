import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, expect, it, vi } from "vitest";
import {
  createTrainingExportController,
  trainingExportStatusCopy,
  type TrainingExportTransport,
  type TrainingExportState,
} from "../src/training-export/controller";

const english = await createPhrasebook({ tag: "en", locale: "en-US" });

function statusText(state: TrainingExportState): string {
  const message = trainingExportStatusCopy(state);
  return message === null ? "" : english.say(message);
}

function subject(
  exportTrainingFile: TrainingExportTransport["exportTrainingFile"] = vi.fn(async () => ({
    status: "saved" as const,
    byteLength: 64,
  })),
) {
  const states: TrainingExportState[] = [];
  const controller = createTrainingExportController({
    transport: { exportTrainingFile },
    view: { render: (state) => states.push(state) },
  });
  return { controller, exportTrainingFile, states };
}

describe("training export controller", () => {
  it("sends a closed ride request and publishes a saved result", async () => {
    const test = subject();
    await test.controller.exportActivity({
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    });
    expect(test.exportTrainingFile).toHaveBeenCalledWith({
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    });
    expect(test.states).toEqual([
      { status: "running", target: "activity" },
      { status: "saved", target: "activity", byteLength: 64 },
    ]);
  });

  it("routes workout archives and preserves cancellations and refusal reasons", async () => {
    const cancelled = subject(vi.fn(async () => ({ status: "cancelled" as const })));
    await cancelled.controller.exportWorkoutArchive({
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "erg",
    });
    expect(cancelled.exportTrainingFile).toHaveBeenCalledWith({
      kind: "workout-archive",
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "erg",
    });
    expect(cancelled.states.at(-1)).toEqual({
      status: "cancelled",
      target: "workout-archive",
    });
    expect(statusText(cancelled.states.at(-1)!)).toBe("Export cancelled. No file was changed.");

    const refused = subject(
      vi.fn(async () => ({ status: "refused" as const, reason: "rate-limited" as const })),
    );
    await refused.controller.exportWorkoutArchive({
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "zwo",
    });
    expect(refused.states.at(-1)).toEqual({
      status: "refused",
      target: "workout-archive",
      reason: "rate-limited",
    });
    expect(statusText(refused.states.at(-1)!)).toMatch(/busy/i);
  });

  it("is single-flight and turns transport failures into a generic local refusal", async () => {
    let release!: () => void;
    const pending = new Promise<{ status: "saved"; byteLength: number }>((resolve) => {
      release = () => resolve({ status: "saved", byteLength: 1 });
    });
    const test = subject(vi.fn(() => pending));
    const first = test.controller.exportActivity({
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    });
    await test.controller.exportWorkoutArchive({
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "zwo",
    });
    expect(test.exportTrainingFile).toHaveBeenCalledOnce();
    release();
    await first;

    const failed = subject(
      vi.fn(async () => {
        throw new Error("private failure");
      }),
    );
    await failed.controller.exportActivity({
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "gpx",
    });
    expect(failed.states.at(-1)).toEqual({
      status: "refused",
      target: "activity",
      reason: "write-failed",
    });
  });
});

import type { PlanCalendarFtpRead, PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { createFtpController, type FtpPanelState } from "../src/activity-review/ftp-controller";

function read(extra: Partial<PlanCalendarFtpRead> = {}): PlanCalendarFtpRead {
  return {
    status: "ftp",
    todayDateKey: 19980819,
    current: { watts: 282, dateKey: 19980713, source: "intervals" },
    history: [{ watts: 282, dateKey: 19980713, source: "intervals" }],
    estimates: [],
    chart: { startDateKey: 19980221, endDateKey: 19980819, steps: [] },
    proposal: {
      kind: "shown",
      watts: 291,
      shownOnDateKey: 19980819,
      percent: 3,
      basis: {
        kind: "drift",
        direction: "above",
        sinceDateKey: 19980806,
        lowWatts: 291,
        highWatts: 291,
        lowestWatts: 291,
      },
    },
    outcome: "none",
    ...extra,
  };
}

function harness(reads: (() => Promise<PlanCalendarRpcResult>)[] = []) {
  const states: FtpPanelState[] = [];
  const answer = vi.fn(async (): Promise<PlanCalendarRpcResult> => read({ outcome: "none" }));
  const written = vi.fn();
  const controller = createFtpController({
    read: vi.fn(async () => (reads.shift() ?? (async () => read()))()),
    answer,
    publish: (state) => states.push(state),
    written,
  });
  return { controller, states, answer, written, last: () => states.at(-1) };
}

describe("the FTP panel controller", () => {
  it("reads the FTP, opens the panel with a fresh read and closes it", async () => {
    const test = harness([async () => read(), async () => read({ proposal: { kind: "none" } })]);
    await test.controller.load();
    expect(test.last()).toMatchObject({ kind: "ready", open: false, notice: "none" });
    test.controller.open();
    expect(test.last()).toMatchObject({ kind: "ready", open: true });
    await vi.waitFor(() =>
      expect(test.last()).toMatchObject({ open: true, read: { proposal: { kind: "none" } } }),
    );
    test.controller.close();
    expect(test.last()).toMatchObject({ kind: "ready", open: false });
  });

  it("loads when the panel opens before the first read, and says when it cannot", async () => {
    const test = harness([() => Promise.reject(new Error("offline"))]);
    test.controller.open();
    await vi.waitFor(() => expect(test.last()).toEqual({ kind: "unavailable", open: true }));
  });

  it("answers with the proposal the panel showed, one answer at a time", async () => {
    const test = harness();
    await test.controller.load();
    test.controller.open();
    let finish: (value: PlanCalendarRpcResult) => void = () => undefined;
    test.answer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = test.controller.answer("use");
    expect(test.last()).toMatchObject({ busy: "use" });
    await test.controller.answer("keep");
    test.controller.close();
    expect(test.last()).toMatchObject({ busy: "use", open: true });
    finish(read({ outcome: "unavailable" }));
    await pending;
    expect(test.answer).toHaveBeenCalledExactlyOnceWith({
      answer: "use",
      expected: { kind: "shown", watts: 291 },
    });
    expect(test.last()).toMatchObject({ busy: null, notice: "unavailable" });
  });

  it("asks the page to read the rides again after a write", async () => {
    const test = harness();
    await test.controller.load();
    test.answer.mockResolvedValueOnce(read({ outcome: "written", proposal: { kind: "none" } }));
    await test.controller.answer("keep");
    expect(test.written).toHaveBeenCalledOnce();
  });

  it("says nothing changed when the app does not answer", async () => {
    const test = harness();
    await test.controller.load();
    test.answer.mockRejectedValueOnce(new Error("gone"));
    await test.controller.answer("confirm");
    expect(test.last()).toMatchObject({ busy: null, notice: "failed" });
  });

  it("sends no answer without a proposal", async () => {
    const test = harness([async () => read({ proposal: { kind: "none" } })]);
    await test.controller.load();
    await test.controller.answer("keep");
    expect(test.answer).not.toHaveBeenCalled();
  });
});

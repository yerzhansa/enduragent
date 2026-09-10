import { describe, expect, it, vi } from "vitest";
import type { ListPlansResult, PlanningReadModel } from "@enduragent/coach-contract";
import type { PlanReadSurfaceState } from "../src/state/plan-slice";
import { createPlanController } from "../src/plan/controller";

const model = {
  schemaVersion: 1 as const,
  status: "no-plan" as const,
  asOfDateKey: 20260826,
  plan: null,
};

describe("Plan controller", () => {
  it("hydrates and preserves the last safe projection on refresh failure", async () => {
    let fail = false;
    const states: PlanReadSurfaceState[] = [];
    const controller = createPlanController({
      listPlans: async () => ({
        calendarConnected: false,
        legacy: null,
        creation: null,
        active: null,
        closed: [],
        pendingChangeCheck: null,
        changesPaused: null,
        changes: [],
      }),
      renderLibrary: vi.fn(),
      read: vi.fn(async () => {
        if (fail) throw new Error("offline");
        return model;
      }),
      render: (state) => states.push(state),
      navigate: vi.fn(),
      focus: vi.fn(),
    });
    await controller.start();
    fail = true;
    await controller.refresh();
    expect(states.at(-1)).toEqual({ status: "unavailable", value: model });
  });

  it("records Chat return navigation without mutating Plan", () => {
    const navigate = vi.fn();
    const focus = vi.fn();
    const controller = createPlanController({
      listPlans: async () => ({
        calendarConnected: false,
        legacy: null,
        creation: null,
        active: null,
        closed: [],
        pendingChangeCheck: null,
        changesPaused: null,
        changes: [],
      }),
      renderLibrary: vi.fn(),
      read: vi.fn(async () => model),
      render: vi.fn(),
      navigate,
      focus,
    });
    const target = {
      destination: "plan" as const,
      focus: "active-plan" as const,
      entityId: "plan-1",
    };
    controller.openFromChat(target);
    expect(focus).toHaveBeenCalledWith(target, true);
    expect(navigate).toHaveBeenCalledWith("plan");
    controller.backToChat();
    expect(focus).toHaveBeenLastCalledWith(null, false);
    expect(navigate).toHaveBeenLastCalledWith("chat");
  });
});

function deferredLibrary() {
  let resolve!: (value: ListPlansResult) => void;
  const promise = new Promise<ListPlansResult>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("Plan library refresh", () => {
  const library: ListPlansResult = {
    calendarConnected: false,
    legacy: null,
    creation: null,
    active: null,
    closed: [],
    pendingChangeCheck: null,
    changesPaused: null,
    changes: [],
  };

  function subject(
    listPlans: () => Promise<ListPlansResult>,
    read: () => Promise<PlanningReadModel> = async () => model,
  ) {
    const renderLibrary = vi.fn();
    const render = vi.fn();
    const controller = createPlanController({
      listPlans,
      read,
      renderLibrary,
      render,
      navigate: vi.fn(),
      focus: vi.fn(),
    });
    return { controller, renderLibrary, render };
  }

  it("retains the last good library when a later list fails independently of the projection", async () => {
    const listPlans = vi
      .fn<() => Promise<ListPlansResult>>()
      .mockResolvedValueOnce(library)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(library);
    const { controller, renderLibrary, render } = subject(listPlans);
    await controller.start();
    await controller.refresh();
    expect(renderLibrary).toHaveBeenLastCalledWith({ status: "unavailable", value: library });
    expect(render).toHaveBeenLastCalledWith({ status: "ready", value: model });
    await controller.refresh();
    expect(renderLibrary).toHaveBeenLastCalledWith({ status: "ready", value: library });
  });

  it("coalesces page reads and queues a fresh list after a Chat mutation", async () => {
    const pending = deferredLibrary();
    const updated: ListPlansResult = {
      ...library,
      closed: [
        {
          planId: "closed-plan",
          version: 2,
          name: "Fitness",
          start: "1998-09-07",
          end: "1998-10-04",
          weeks: 4,
          status: "closed",
          closeReason: "completed",
          closedAt: "1998-10-04",
          activatedAt: "1998-09-07",
          calendar: { status: "pending", window: null, currentThrough: null, error: null },
          creationId: null,
        },
      ],
    };
    const listPlans = vi
      .fn<() => Promise<ListPlansResult>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(updated);
    const { controller, renderLibrary } = subject(listPlans);
    const initial = controller.start();
    expect(controller.refresh()).toBe(initial);
    const mutation = controller.refresh(true);
    expect(listPlans).toHaveBeenCalledOnce();
    pending.resolve(library);
    await mutation;
    expect(listPlans).toHaveBeenCalledTimes(2);
    expect(renderLibrary).toHaveBeenLastCalledWith({ status: "ready", value: updated });
  });

  it("ignores pending results and queued mutation refreshes after disposal", async () => {
    const pending = deferredLibrary();
    const listPlans = vi.fn(() => pending.promise);
    const { controller, renderLibrary } = subject(listPlans);
    const initial = controller.start();
    const mutation = controller.refresh(true);
    controller.dispose();
    pending.resolve(library);
    await Promise.all([initial, mutation]);
    await controller.refresh();
    expect(renderLibrary).not.toHaveBeenCalled();
    expect(listPlans).toHaveBeenCalledOnce();
  });
});

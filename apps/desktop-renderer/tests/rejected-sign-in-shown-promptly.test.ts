import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopCoachClientProvider } from "../src/coach-client";
import { createIntervalsSignInHealth } from "../src/intervals-sign-in-health";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { intervalsSignInNeedsRenewal } from "../src/state/sync-slice";
import { createTrainingSyncCoordinator } from "../src/training-sync";
import { runtimeSnapshot, startFakeCoachSocket } from "./fake-coach-socket";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("a sign-in the coach rejects in the background", () => {
  it("shows Sign in again within a minute with no focus and no sync from the window", async () => {
    let rejectedInCoach = false;
    const coach = await startFakeCoachSocket((method, reply) => {
      if (method === "getRuntimeConfig") {
        reply.result(runtimeSnapshot(rejectedInCoach ? { credential_rejected: true } : {}));
      }
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    useEnduragentStore.setState({
      intervalsSignInRejected: false,
      onboarding: {
        ...READY_ONBOARDING,
        wizard: {
          ...READY_ONBOARDING.wizard,
          credentialStatus: {
            ...READY_ONBOARDING.wizard.credentialStatus,
            "intervals-icu": "configured",
          },
        },
      },
    });
    const health = createIntervalsSignInHealth(
      createDesktopCoachClientProvider(),
      useEnduragentStore,
    );
    const coordinator = createTrainingSyncCoordinator({
      clients: health.clients,
      refreshTrainingContext: async () => {},
    });
    const neverFocused = new EventTarget() as unknown as Window;
    const stop = health.follow(coordinator, neverFocused);
    try {
      await vi.waitUntil(() => coach.received.includes("getRuntimeConfig"), { timeout: 2_000 });
      await realDelay(50);
      expect(intervalsSignInNeedsRenewal(useEnduragentStore.getState())).toBe(false);

      rejectedInCoach = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await realDelay(200);

      expect(
        intervalsSignInNeedsRenewal(useEnduragentStore.getState()),
        "Sign in again a minute after the coach rejected the sign-in in the background",
      ).toBe(true);
      expect(coach.received).not.toContain("sync");
    } finally {
      stop();
      coordinator.dispose();
      await health.clients.close();
      await coach.close();
    }
  });
});

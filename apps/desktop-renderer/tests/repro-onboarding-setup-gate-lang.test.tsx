import { createPhrasebook } from "@enduragent/i18n/messages";
import { LanguageProvider } from "@enduragent/i18n/react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupGate } from "../src/app/SetupGate";
import { createOnboardingController } from "../src/onboarding/controller";
import { createOnboardingViewAdapter } from "../src/state/adapters/onboarding";
import { credentialDrafts } from "../src/state/credential-drafts";
import { SETUP_HEADING } from "../src/ui/onboarding/copy";
import { useEnduragentStore } from "../src/state/store";
import { resetOnboardingStore, testBridge } from "./onboarding-harness";

describe("repro onboarding G: Setup gate language", () => {
  afterEach(() => resetOnboardingStore());

  it("marks the Setup gate with the app language, not English", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: false,
    }));
    const adapter = createOnboardingViewAdapter({
      publish: (next) => useEnduragentStore.getState().setOnboarding(next),
    });
    const controller = createOnboardingController({
      bridge,
      credentials: credentialDrafts,
      view: adapter.view,
      onComplete: vi.fn(),
    });
    useEnduragentStore.getState().bindOnboardingActions(controller);
    const phrasebook = await createPhrasebook({ tag: "de", locale: "de-DE" });
    const view = render(
      <LanguageProvider tag="de" locale="de-DE" phrasebook={phrasebook}>
        <SetupGate />
      </LanguageProvider>,
    );
    await act(async () => controller.open());

    const gate = view.container.querySelector("main");
    const title = view.container.querySelector("#setup-panel-title")?.textContent ?? "";
    expect(title).toBe(phrasebook.say(SETUP_HEADING));
    expect(title).not.toBe("Get your coach running before you can chat");
    expect({ title, lang: gate?.getAttribute("lang") }).toEqual({ title, lang: "de" });
    controller.dispose();
  });
});

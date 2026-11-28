import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramSettingsController } from "../src/settings/telegram-controller";
import { createTelegramSettingsAdapter } from "../src/state/adapters/telegram";
import { useEnduragentStore } from "../src/state/store";
import { mountWizard, resetOnboardingStore, testBridge } from "./onboarding-harness";

describe("repro onboarding G8b: Telegram status fails to load", () => {
  afterEach(() => resetOnboardingStore());

  it("tells the athlete Telegram is unavailable instead of offering a plain Create", async () => {
    const adapter = createTelegramSettingsAdapter({
      publish: (next) => useEnduragentStore.getState().patchSettings({ telegram: next }),
    });
    const refused = async () => {
      throw new TypeError("synthetic Telegram control unavailable");
    };
    const telegram = createTelegramSettingsController({
      bridge: {
        status: vi.fn(refused),
        pasteTokenFromClipboard: vi.fn(refused),
        enable: vi.fn(refused),
        disable: vi.fn(refused),
        remove: vi.fn(refused),
        reconcile: vi.fn(refused),
        removeWebhook: vi.fn(refused),
        beginPairing: vi.fn(refused),
        cancelPairing: vi.fn(refused),
        acknowledgeGapWarning: vi.fn(refused),
        listAllowedSenders: vi.fn(refused),
        addAllowedSender: vi.fn(refused),
        removeAllowedSender: vi.fn(refused),
      } as never,
      beginMutation: () => () => {},
      view: adapter.view,
      setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
    });
    useEnduragentStore.setState({ settingsPorts: { telegram: adapter.port } as never });
    await act(async () => telegram.activate());
    expect(useEnduragentStore.getState().settings.telegram).toMatchObject({
      status: "error",
      kind: "load",
    });

    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const row = document.querySelector<HTMLElement>('[data-setup-row="telegram"]');
    const create = document.querySelector<HTMLButtonElement>('[data-setup-trigger="telegram"]');
    const rowText = row?.textContent ?? "";
    console.info(
      `G8b row: ${rowText}; Create enabled: ${String(create !== null && !create.disabled)}`,
    );
    expect({
      errorShown:
        rowText.includes("aren’t available") ||
        (document.body.textContent ?? "").includes("Telegram settings aren’t available"),
      retryOffered: screen.queryByRole("button", { name: /retry|try again/iu }) !== null,
    }).toEqual({ errorShown: true, retryOffered: true });
    wizard.controller.dispose();
    telegram.dispose();
  });
});

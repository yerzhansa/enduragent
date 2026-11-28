import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell";
import { createLanguageSettingsController } from "../src/settings/language-controller";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { renderWithLanguage } from "./language-harness";

describe("repro onboarding G6a: Setup before the language screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useEnduragentStore.setState({
      onboarding: CLOSED_ONBOARDING,
      onboardingActions: null,
      settings: EMPTY_SETTINGS_SURFACE,
      settingsPorts: null,
    });
  });

  it("does not show Setup while it is still unknown whether the language screen is needed", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk"]);
    let answer!: (value: { value: null }) => void;
    const call = vi.fn(
      () =>
        new Promise<{ value: null }>((resolve) => {
          answer = resolve;
        }),
    );
    const language = createLanguageSettingsController({
      clients: { getClient: async () => ({ call }) as never },
      view: { render: (next) => useEnduragentStore.getState().patchSettings({ language: next }) },
    });
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
      settingsPorts: { language: { set: vi.fn() } } as never,
    });
    void language.start();
    await renderWithLanguage(<Shell onReady={() => {}} />);
    await act(async () => Promise.resolve());

    const whileLoading = {
      language: useEnduragentStore.getState().settings.language.status,
      shell: document.querySelector("[data-shell]")?.getAttribute("data-shell"),
      setupShown: document.querySelector("#setup-panel-title") !== null,
    };
    await act(async () => answer({ value: null }));
    const afterRead = document.querySelector("[data-shell]")?.getAttribute("data-shell");

    expect({ whileLoading, afterRead }).toEqual({
      whileLoading: {
        language: "loading",
        shell: expect.not.stringMatching(/^gate$/u),
        setupShown: false,
      },
      afterRead: "language",
    });
    language.dispose();
  });

  it("shows Setup once the language read resolves to a saved preference or becomes unavailable", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk"]);
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
      settings: { ...EMPTY_SETTINGS_SURFACE, language: { status: "loading", value: null } },
      settingsPorts: { language: { set: vi.fn() } } as never,
    });
    await renderWithLanguage(<Shell onReady={() => {}} />);

    expect(document.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("unknown");

    await act(async () => {
      useEnduragentStore
        .getState()
        .patchSettings({ language: { status: "unavailable", value: null } });
    });
    expect(document.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("gate");
  });

  it("keeps Setup shown when a saved language is already known during a refresh", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk"]);
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
      settings: { ...EMPTY_SETTINGS_SURFACE, language: { status: "loading", value: "de" } },
      settingsPorts: { language: { set: vi.fn() } } as never,
    });
    await renderWithLanguage(<Shell onReady={() => {}} />);

    expect(document.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("gate");
  });

  it("shows Setup immediately when the OS language is already supported", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
      settings: { ...EMPTY_SETTINGS_SURFACE, language: { status: "loading", value: null } },
      settingsPorts: { language: { set: vi.fn() } } as never,
    });
    await renderWithLanguage(<Shell onReady={() => {}} />);

    expect(document.querySelector("[data-shell]")?.getAttribute("data-shell")).toBe("gate");
  });
});

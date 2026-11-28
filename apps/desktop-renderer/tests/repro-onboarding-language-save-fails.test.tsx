import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell";
import { createLanguageSettingsController } from "../src/settings/language-controller";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { renderWithLanguage } from "./language-harness";

describe("repro onboarding G6b: first-launch language save fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useEnduragentStore.setState({
      onboarding: CLOSED_ONBOARDING,
      onboardingActions: null,
      settings: EMPTY_SETTINGS_SURFACE,
      settingsPorts: null,
    });
  });

  it("keeps the language screen up when the choice cannot be saved", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk"]);
    const call = vi.fn(async (method: string) => {
      if (method === "setLanguagePreference") throw new TypeError("synthetic save failure");
      return { value: null };
    });
    const language = createLanguageSettingsController({
      clients: { getClient: async () => ({ call }) as never },
      view: { render: (next) => useEnduragentStore.getState().patchSettings({ language: next }) },
    });
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
      settingsPorts: { language: { set: (value: never) => void language.set(value) } } as never,
    });
    await act(async () => language.start());
    await renderWithLanguage(<Shell onReady={() => {}} />);
    expect(document.querySelector("[data-shell]")).toHaveAttribute("data-shell", "language");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "Deutsch" }));
    await user.click(await screen.findByRole("button", { name: "Weiter" }));
    await act(async () => Promise.resolve());

    expect(call).toHaveBeenCalledWith("setLanguagePreference", { value: "de" });
    expect({
      shell: document.querySelector("[data-shell]")?.getAttribute("data-shell"),
      setupTitle: document.querySelector("#setup-panel-title")?.textContent ?? null,
    }).toEqual({ shell: "language", setupTitle: null });
    language.dispose();
  });
});

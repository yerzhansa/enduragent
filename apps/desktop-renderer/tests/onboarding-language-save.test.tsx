import { createPhrasebook } from "@enduragent/i18n/messages";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell";
import { createLanguageSettingsController } from "../src/settings/language-controller";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { renderWithLanguage } from "./language-harness";

const german = await createPhrasebook({ tag: "de", locale: "de-DE" });

async function firstLaunchWithFailingSave() {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk"]);
  let saveFails = true;
  let nextRead: Promise<{ value: null }> = Promise.resolve({ value: null });
  const call = vi.fn(async (method: string, params: { value?: string | null }) => {
    if (method !== "setLanguagePreference") return nextRead;
    if (saveFails) throw new TypeError("synthetic save failure");
    return { value: params.value ?? null };
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
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Language" }));
  await user.click(await screen.findByRole("option", { name: "Deutsch" }));
  await user.click(await screen.findByRole("button", { name: german.say("language.continue") }));
  await screen.findByRole("alert");
  return {
    call,
    language,
    user,
    saveSucceeds: () => {
      saveFails = false;
    },
    holdNextRead: () => {
      let answer = (): void => {};
      nextRead = new Promise((resolve) => {
        answer = () => resolve({ value: null });
      });
      return () => answer();
    },
  };
}

function shellKind(): string | null | undefined {
  return document.querySelector("[data-shell]")?.getAttribute("data-shell");
}

describe("first-launch language save failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useEnduragentStore.setState({
      onboarding: CLOSED_ONBOARDING,
      onboardingActions: null,
      settings: EMPTY_SETTINGS_SURFACE,
      settingsPorts: null,
    });
  });

  it("shows the error with Retry in the chosen language, then saves on Retry", async () => {
    const f = await firstLaunchWithFailingSave();
    expect(shellKind()).toBe("language");
    expect(screen.getByRole("alert")).toHaveTextContent(german.say("language.saveFailed"));
    expect(
      screen.getByRole("combobox", { name: german.say("settings.language.title") }),
    ).toHaveTextContent("Deutsch");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      german.say("language.retry"),
    ]);

    f.saveSucceeds();
    await f.user.click(screen.getByRole("button", { name: german.say("language.retry") }));

    await waitFor(() => expect(shellKind()).toBe("gate"));
    expect(f.call.mock.calls.filter(([method]) => method === "setLanguagePreference")).toEqual([
      ["setLanguagePreference", { value: "de" }],
      ["setLanguagePreference", { value: "de" }],
    ]);
    expect(useEnduragentStore.getState().settings.language).toEqual({
      status: "ready",
      value: "de",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    f.language.dispose();
  });

  it("keeps the language screen, never Setup, when the coach reconnects after the failure", async () => {
    const f = await firstLaunchWithFailingSave();
    const shell = document.querySelector("[data-shell]");
    if (shell === null) throw new Error("Shell missing");
    const shells: (string | null | undefined)[] = [];
    const record = (records: MutationRecord[]): void => {
      shells.push(...records.map((change) => change.oldValue));
    };
    const observer = new MutationObserver(record);
    observer.observe(shell, { attributeFilter: ["data-shell"], attributeOldValue: true });

    const answerRead = f.holdNextRead();
    let refresh: Promise<void> = Promise.resolve();
    await act(async () => {
      refresh = f.language.refresh();
    });
    answerRead();
    await act(async () => refresh);
    record(observer.takeRecords());
    observer.disconnect();
    shells.push(shellKind());

    expect(shells).not.toContain("gate");
    expect(shellKind()).toBe("language");
    expect(document.querySelector("#setup-panel-title")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    f.language.dispose();
  });
});

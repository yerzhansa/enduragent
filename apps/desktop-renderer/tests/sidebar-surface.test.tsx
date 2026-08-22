import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice.js";
import {
  restoreManualSyncFocus,
  setManualSyncFocusTarget,
} from "../src/state/manual-sync-focus.js";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice.js";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice.js";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice.js";
import { toManualSyncViewState } from "../src/training-context/manual-sync.js";
import { Sidebar } from "../src/ui/sidebar/Sidebar.js";
import { clearTrainingRestrictionFocusRequest } from "../src/ui/training/restriction-focus.js";

function stubActions(): ChatActions {
  return {
    submit: vi.fn(),
    removeQueued: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
  };
}

function update(patch: Partial<Parameters<typeof useEnduragentStore.setState>[0]>): void {
  act(() => {
    useEnduragentStore.setState(patch);
  });
}

function chip(): HTMLElement {
  const element = document.querySelector("button.sync-chip");
  if (!(element instanceof HTMLElement)) throw new TypeError("sync chip missing");
  return element;
}

function chipSurface(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-sync-chip]");
  if (element === null) throw new TypeError("sync chip surface missing");
  return element;
}

function stravaDroppedActivities() {
  return {
    overall: {
      total: 67,
      visible: 5,
      restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 60 }],
      other: 2,
    },
    recent7Days: {
      total: 5,
      visible: 1,
      restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 4 }],
      other: 0,
    },
  };
}

function setupReadiness(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-sidebar-setup-readiness]");
  if (element === null) throw new TypeError("sidebar setup readiness missing");
  return element;
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
    chatActions: stubActions(),
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    onboarding: READY_ONBOARDING,
    onboardingActions: null,
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

afterEach(() => {
  setManualSyncFocusTarget(null);
  clearTrainingRestrictionFocusRequest();
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    onboarding: CLOSED_ONBOARDING,
    onboardingActions: null,
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

describe("sidebar update action", () => {
  it("appears only when an update is ready and names its version", () => {
    render(<Sidebar />);

    const hiddenStates = [
      { status: "disabled" },
      { status: "idle" },
      { status: "checking" },
      { status: "current" },
      { status: "downloading", version: "1998.7.7" },
      { status: "failed", stage: "check" },
      { status: "failed", stage: "download" },
    ] as const;
    for (const state of hiddenStates) {
      update({
        settings: {
          ...EMPTY_SETTINGS_SURFACE,
          update: { state, actionDisabled: false },
        },
      });
      expect(screen.queryByText("Update available")).not.toBeInTheDocument();
    }

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
    });

    expect(
      screen.getByRole("button", { name: "Install update version 1998.7.7" }),
    ).toHaveTextContent("Update available");
  });

  it("activates the existing updater port once", async () => {
    const user = userEvent.setup();
    const activate = vi.fn();
    useEnduragentStore.setState({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
      settingsPorts: { update: { activate } } as never,
    });
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Install update version 1998.7.7" }));

    expect(activate).toHaveBeenCalledOnce();
  });

  it("keeps the restarting state visible, busy and inert", () => {
    useEnduragentStore.setState({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: true,
        },
      },
      settingsPorts: { update: { activate: vi.fn() } } as never,
    });
    render(<Sidebar />);

    const restarting = screen.getByRole("button", {
      name: "Restarting to install update version 1998.7.7",
    });
    expect(restarting).toHaveTextContent("Restarting…");
    expect(restarting).toBeDisabled();
    expect(restarting).toHaveAttribute("aria-busy", "true");

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "installing", version: "1998.7.8" },
          actionDisabled: false,
        },
      },
    });
    expect(
      screen.getByRole("button", {
        name: "Restarting to install update version 1998.7.8",
      }),
    ).toBeDisabled();
  });

  it("announces availability politely and respects sidebar locks", () => {
    useEnduragentStore.setState({ settingsPorts: { update: { activate: vi.fn() } } as never });
    render(<Sidebar />);

    const announcement = document.querySelector(".update-announcement");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toBeEmptyDOMElement();

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
      onboarding: { ...CLOSED_ONBOARDING, open: true },
    });
    expect(announcement).toHaveTextContent("Update version 1998.7.7 is available");
    expect(screen.getByRole("button", { name: "Install update version 1998.7.7" })).toBeEnabled();

    update({
      onboarding: CLOSED_ONBOARDING,
      activeView: "settings",
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        savingOwners: ["synthetic-lock"],
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
    });
    expect(screen.getByRole("button", { name: "Install update version 1998.7.7" })).toBeDisabled();
  });
});

describe("sidebar information hierarchy", () => {
  it("omits redundant conversation and process-status surfaces", () => {
    render(<Sidebar />);

    expect(screen.queryByText("Conversations")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Current conversation/u })).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(document.querySelector(".connection-status")).not.toBeInTheDocument();
  });
});

describe("sidebar styling", () => {
  it("uses local UI buttons and Tailwind without the legacy module or mono copy", async () => {
    const sources = await Promise.all(
      ["Sidebar.tsx", "SyncChip.tsx", "UpdateAvailableButton.tsx"].map((name) =>
        readFile(resolve(import.meta.dirname, "..", "src", "ui", "sidebar", name), "utf8"),
      ),
    );
    expect(sources.every((source) => source.includes("components/ui/button.js"))).toBe(true);
    expect(sources.join("\n")).not.toContain("Sidebar.module.css");
    expect(sources.join("\n")).not.toContain("font-mono");
  });
});

describe("sidebar sync chip", () => {
  it("walks the loading, synced, syncing and attention states", () => {
    render(<Sidebar />);

    expect(chip()).toHaveAttribute("data-status", "loading");
    expect(chipSurface()).toHaveClass("min-w-0");
    expect(chipSurface()).toHaveTextContent("Loading training data");
    expect(screen.getByText("Sync now")).toHaveClass("max-[860px]:hidden");

    update({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
      },
    });
    expect(chip()).toHaveAttribute("data-status", "synced");
    expect(chipSurface()).toHaveTextContent("Training data synced");
    expect(chipSurface()).toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(chip()).toHaveAccessibleName(
      "Sync now · Training data synced · 1998-07-19 07:55:00 UTC",
    );

    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    expect(chip()).toHaveAttribute("data-status", "syncing");
    expect(chip()).toBeDisabled();

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "partial",
        retryable: true,
      }),
    });
    expect(chip()).toHaveAttribute("data-status", "attention");
    expect(chipSurface()).toHaveTextContent("Try again");
  });

  it("keeps Strava remedy navigation independent from syncing", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    update({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
      },
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: stravaDroppedActivities(),
      }),
    });

    expect(chip()).toHaveAttribute("data-status", "synced");
    expect(chipSurface()).toHaveTextContent("60 hidden by Strava");
    expect(chipSurface()).toHaveTextContent("How to fix this");
    expect(chipSurface()).not.toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(chip()).toHaveAttribute("title", "1998-07-19 07:55:00 UTC");
    expect(chip()).toHaveAccessibleName(
      "Sync again · Training data synced · 1998-07-19 07:55:00 UTC",
    );
    expect(
      chip().querySelector("a, button, input, select, textarea, [role='button'], [tabindex]"),
    ).toBeNull();

    const link = screen.getByRole("link", {
      name: "60 hidden by Strava. How to fix this",
    });
    expect(link).toHaveAttribute("href", "#strava-restricted-activities");
    expect(link).toHaveAttribute("data-info-tip");
    await user.hover(link);
    await waitFor(() => {
      expect(document.querySelector("[data-info-tip-popup]")).not.toBeNull();
    });
    expect(screen.getByText("60 activities hidden by Strava")).toBeInTheDocument();
    const popup = document.querySelector<HTMLElement>("[data-info-tip-popup]");
    expect(
      popup?.querySelector("a, button, input, select, textarea, [role='button'], [tabindex]"),
    ).toBeNull();

    await user.click(link);
    expect(useEnduragentStore.getState().activeView).toBe("training");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({ activeView: "chat" });
    chip().focus();
    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useEnduragentStore.getState().activeView).toBe("training");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({ activeView: "chat" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    fireEvent.click(link, { detail: 1 });
    expect(useEnduragentStore.getState().activeView).toBe("training");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({
      activeView: "chat",
      sync: {
        ...toManualSyncViewState({ status: "running", operation: 2 }),
        droppedActivities: stravaDroppedActivities(),
      },
    });
    expect(chip()).toBeDisabled();
    expect(link).toBeEnabled();
    await user.click(link);
    expect(useEnduragentStore.getState().activeView).toBe("training");
    expect(request).not.toHaveBeenCalled();

    update({
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 2,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 5, visible: 5, restrictions: [], other: 0 },
          recent7Days: { total: 5, visible: 5, restrictions: [], other: 0 },
        },
      }),
    });
    expect(chipSurface()).toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(chip()).not.toHaveAttribute("title");
    expect(chipSurface().querySelector("[data-info-tip]")).toBeNull();
  });

  it("reports never-synced and unavailable training data honestly", () => {
    render(<Sidebar />);

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "ready" } });
    expect(chip()).toHaveAttribute("data-status", "never");
    expect(chipSurface()).toHaveTextContent("Not synced yet");

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "unavailable" } });
    expect(chip()).toHaveAttribute("data-status", "unavailable");
    expect(chipSurface()).toHaveTextContent("Training data unavailable");
  });

  it("requests a manual sync and restores keyboard focus to the activator", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    await user.click(chip());
    expect(request).toHaveBeenNthCalledWith(1, "pointer");
    act(() => {
      chip().blur();
    });
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(chip());
    expect(request).toHaveBeenNthCalledWith(2, "keyboard");
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(chip());
  });

  it("stays inert until the sync controller is bound", () => {
    render(<Sidebar />);

    expect(chip()).toBeDisabled();
  });
});

describe("sidebar setup gating", () => {
  it("shows whether required setup is ready", () => {
    render(<Sidebar />);

    expect(setupReadiness()).toHaveAttribute("data-sidebar-setup-readiness", "ready");
    expect(setupReadiness()).toHaveTextContent("Ready");
    expect(setupReadiness().querySelector("[data-sidebar-setup-dot]")).toHaveAttribute(
      "data-sidebar-setup-dot",
      "ready",
    );
    expect(setupReadiness().querySelector("[data-sidebar-setup-dot]")).toHaveClass("bg-ok");

    update({ onboarding: { ...CLOSED_ONBOARDING, initialized: true, loading: false } });

    expect(setupReadiness()).toHaveAttribute("data-sidebar-setup-readiness", "waiting");
    expect(setupReadiness()).toHaveTextContent("Waiting for setup");
    expect(setupReadiness().querySelector("[data-sidebar-setup-dot]")).toHaveAttribute(
      "data-sidebar-setup-dot",
      "waiting",
    );
    expect(setupReadiness().querySelector("[data-sidebar-setup-dot]")).toHaveClass("bg-warn");
  });

  it("says setup is being checked only while initial status is unknown", () => {
    render(<Sidebar />);

    update({ onboarding: CLOSED_ONBOARDING });

    expect(setupReadiness()).toHaveAttribute("data-sidebar-setup-readiness", "checking");
    expect(setupReadiness()).toHaveTextContent("Checking setup…");
    expect(setupReadiness()).not.toHaveTextContent("Waiting for setup");

    update({ onboarding: { ...READY_ONBOARDING, loadUnavailable: true } });

    expect(setupReadiness()).toHaveAttribute("data-sidebar-setup-readiness", "ready");
    expect(setupReadiness()).toHaveTextContent("Ready");
  });

  it("waits when initialized setup is partially ready and still requires completion", () => {
    render(<Sidebar />);

    update({
      onboarding: {
        ...READY_ONBOARDING,
        completionRequired: true,
        readiness: { provider: true, trainingData: true, intake: false },
      },
    });

    expect(setupReadiness()).toHaveAttribute("data-sidebar-setup-readiness", "waiting");
    expect(setupReadiness()).toHaveTextContent("Waiting for setup");
  });

  it("has no Setup destination and keeps non-chat destinations usable", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({ onboarding: CLOSED_ONBOARDING });
    render(<Sidebar />);

    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Training" }));
    expect(useEnduragentStore.getState().activeView).toBe("training");
  });
});

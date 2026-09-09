import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_ARCHIVE_SURFACE,
  type ArchiveReadingState,
  type ArchiveViewState,
} from "../src/archive/controller";
import { Shell } from "../src/app/Shell";
import type { ArchiveActions } from "../src/state/archive-slice";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { ArchiveView } from "../src/ui/archive/ArchiveView";

const NEWER = "a".repeat(64);
const OLDER = "b".repeat(64);

function archiveActions(): ArchiveActions {
  return {
    refresh: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    loadEarlier: vi.fn(),
    retry: vi.fn(),
    requestDeletion: vi.fn(),
    cancelDeletion: vi.fn(),
    confirmDeletion: vi.fn(),
  };
}

function chatActions(): ChatActions {
  return {
    openPlanChangeEditor: vi.fn(),
    backFromPlanChangeEditor: vi.fn(),
    previewPlanChange: vi.fn(),
    applyPlanChange: vi.fn(),
    submit: vi.fn(),
    chooseAttachments: vi.fn(),
    pasteAttachment: vi.fn(),
    receiveAttachmentAdmissions: vi.fn(),
    saveAttachmentDraftText: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    selectAttachmentWorkout: vi.fn(),
    reviewAttachmentInPlan: vi.fn(),
    continueMessageInPlan: vi.fn(),
    openPlanningRequest: vi.fn(),
    retryPlanningRequest: vi.fn(),
    retryPlanningRequestLoad: vi.fn(),
    clearPlanningRequestFocus: vi.fn(),
    startPlanCreation: vi.fn(),
    buildPlanCreationDraft: vi.fn(),
    answerPlanCreation: vi.fn(),
    pausePlanCreation: vi.fn(),
    continuePlanCreation: vi.fn(),
    editPlanCreation: vi.fn(),
    cancelPlanCreationEdit: vi.fn(),
    openPlanCreationDiscard: vi.fn(),
    cancelPlanCreationDiscard: vi.fn(),
    confirmPlanCreationDiscard: vi.fn(),
    openPlanCreationActivate: vi.fn(),
    cancelPlanCreationActivate: vi.fn(),
    confirmPlanCreationActivate: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    removeQueued: vi.fn(),
    runQueuedCommand: vi.fn(),
    retryQueuedTurn: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
    answerDecision: vi.fn(),
    skipDecision: vi.fn(),
    retryDecision: vi.fn(),
  };
}

const LISTED: ArchiveViewState = {
  listStatus: "ready",
  conversations: [
    {
      boundaryRef: NEWER,
      boundaryAt: "1998-07-19T08:15:00.000Z",
      reason: "explicit-reset",
      turnCount: 3,
    },
    {
      boundaryRef: OLDER,
      boundaryAt: "1998-07-12T07:30:00.000Z",
      reason: "stale-reset",
      turnCount: 1,
    },
  ],
  truncated: false,
  reading: null,
  deletion: null,
};

function reading(patch: Partial<ArchiveReadingState> = {}): ArchiveViewState {
  return {
    ...LISTED,
    reading: {
      boundaryRef: NEWER,
      boundaryAt: "1998-07-19T08:15:00.000Z",
      status: "ready",
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-19T07:00:00.000Z",
          athleteText: "How did last week look?",
          coachText: "**Solid** week.",
        },
      ],
      hasEarlier: false,
      ...patch,
    },
  };
}

function set(next: ArchiveViewState, actions: ArchiveActions): void {
  act(() => {
    useEnduragentStore.setState({ archive: next, archiveActions: actions });
  });
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    runtimeReady: true,
    archive: EMPTY_ARCHIVE_SURFACE,
    archiveActions: null,
    chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
    chatActions: chatActions(),
    onboarding: READY_ONBOARDING,
    onboardingActions: null,
    onboardingStartupSettled: true,
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    archive: EMPTY_ARCHIVE_SURFACE,
    archiveActions: null,
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
  });
});

describe("past chats list", () => {
  it("requests the list once the controller is bound and opens an entry on click", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    useEnduragentStore.setState({ archive: LISTED, archiveActions: actions });
    render(<ArchiveView />);

    expect(actions.refresh).toHaveBeenCalledOnce();
    const region = screen.getByRole("region", { name: "Past chats" });
    const entries = region.querySelectorAll("button.archive-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveClass(
      "h-auto",
      "grid-cols-1",
      "items-start",
      "justify-start",
      "whitespace-normal",
      "font-normal",
    );
    expect(entries[0]).not.toHaveClass("h-ctl", "justify-center", "whitespace-nowrap");
    expect(entries[0]).toHaveAccessibleName(
      "1998-07-19 08:15 UTC · 3 messages · You started a new conversation",
    );
    expect(entries[0]).toHaveTextContent("1998-07-19 08:15 UTC");
    expect(entries[0]).toHaveTextContent("3 messages");
    expect(entries[1]).toHaveTextContent("1 message");
    expect(within(region).getByText("Past conversations are read-only.")).toBeInTheDocument();

    await user.click(entries[0] as HTMLElement);
    expect(actions.open).toHaveBeenNthCalledWith(1, NEWER);
  });

  it("stays inert until the controller binds and reports an empty archive", () => {
    render(<ArchiveView />);

    const region = screen.getByRole("region", { name: "Past chats" });
    expect(region.querySelectorAll("button.archive-entry")).toHaveLength(0);
    expect(region.querySelector("p.archive-status")).toHaveTextContent(
      "Loading past conversations…",
    );

    set({ ...EMPTY_ARCHIVE_SURFACE, listStatus: "ready" }, archiveActions());
    expect(region.querySelector("p.archive-empty")).not.toHaveAttribute("hidden");
    expect(region.querySelector("p.archive-status")).toHaveAttribute("hidden");
  });

  it("surfaces a list failure with a retry that reaches the controller", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    render(<ArchiveView />);
    set({ ...EMPTY_ARCHIVE_SURFACE, listStatus: "failed" }, actions);

    const region = screen.getByRole("region", { name: "Past chats" });
    expect(region.querySelector("p.archive-status")).toHaveTextContent(
      "Past conversations are temporarily unavailable.",
    );
    await user.click(within(region).getByRole("button", { name: "Try again" }));
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it("notes truncation only when older conversations are unlisted", () => {
    const actions = archiveActions();
    render(<ArchiveView />);
    set(LISTED, actions);
    const region = screen.getByRole("region", { name: "Past chats" });
    expect(region.querySelector("p.archive-truncated")).toHaveAttribute("hidden");

    set({ ...LISTED, truncated: true }, actions);
    expect(region.querySelector("p.archive-truncated")).not.toHaveAttribute("hidden");
  });
});

describe("past chats reader", () => {
  it("renders a read-only transcript with back navigation and no composer", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    render(<ArchiveView />);
    set(reading(), actions);

    const region = screen.getByRole("region", { name: "Past chats" });
    const thread = within(region).getByRole("region", { name: "Past conversation" });
    expect(thread.querySelectorAll("article.archive-message")).toHaveLength(2);
    expect(thread).toHaveTextContent("How did last week look?");
    expect(thread.querySelector(".archive-message--coach strong")).toHaveTextContent("Solid");
    expect(region.querySelector("textarea")).toBeNull();
    expect(region.querySelector("button.archive-load-earlier")).toHaveAttribute("hidden");
    expect(within(region).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(region).queryByRole("button", { name: /Retry/u })).toBeNull();
    expect(region.querySelectorAll("button.archive-entry")).toHaveLength(0);

    await user.click(within(region).getByRole("button", { name: "All past chats" }));
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("renders one athlete row and every Coach attempt for a recovered logical turn", () => {
    const actions = archiveActions();
    render(<ArchiveView />);
    const first = reading().reading!.turns[0]!;
    set(
      reading({
        turns: [
          { ...first, coachText: "Partial", delivery: "interrupted" },
          {
            ...first,
            completedAt: "1998-07-19T07:01:00.000Z",
            coachText: "Recovered",
          },
        ],
      }),
      actions,
    );

    const thread = screen.getByRole("region", { name: "Past conversation" });
    expect(thread.querySelectorAll(".archive-message--athlete")).toHaveLength(1);
    expect(thread.querySelectorAll(".archive-message--coach")).toHaveLength(2);
    expect(thread.querySelectorAll('[data-delivery="interrupted"]')).toHaveLength(1);
    expect(thread).toHaveTextContent("Partial");
    expect(thread).toHaveTextContent("Recovered");
  });

  it("pages earlier messages and blocks the pill while a page is in flight", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    render(<ArchiveView />);
    set(reading({ hasEarlier: true }), actions);

    const region = screen.getByRole("region", { name: "Past chats" });
    await user.click(within(region).getByRole("button", { name: "Load earlier messages" }));
    expect(actions.loadEarlier).toHaveBeenCalledOnce();

    set(reading({ hasEarlier: true, status: "loading" }), actions);
    expect(region.querySelector("button.archive-load-earlier")).toBeDisabled();
    expect(region.querySelector("p.archive-reading-status")).toHaveTextContent(
      "Loading past conversations…",
    );
  });

  it("offers retry after a page failure and refuses retry once unavailable", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    render(<ArchiveView />);
    set(reading({ hasEarlier: true, status: "failed" }), actions);

    const region = screen.getByRole("region", { name: "Past chats" });
    expect(region.querySelector("p.archive-reading-status")).toHaveTextContent(
      "This conversation is temporarily unavailable.",
    );
    expect(region.querySelector("button.archive-load-earlier")).toHaveAttribute("hidden");
    await user.click(within(region).getByRole("button", { name: "Try again" }));
    expect(actions.retry).toHaveBeenCalledOnce();

    set(reading({ status: "unavailable", turns: [] }), actions);
    expect(region.querySelector("p.archive-reading-status")).toHaveTextContent(
      "This conversation is no longer available.",
    );
    expect(region.querySelector("button.archive-retry")).toHaveAttribute("hidden");
  });

  it("explains permanent deletion, focuses Cancel, and restores the trigger on Escape", async () => {
    const user = userEvent.setup();
    let actions!: ArchiveActions;
    const requestDeletion = vi.fn((boundaryRef: string) => {
      set(
        {
          ...reading(),
          deletion: { boundaryRef, status: "confirming" },
        },
        actions,
      );
    });
    const cancelDeletion = vi.fn(() => {
      set(reading(), actions);
    });
    actions = { ...archiveActions(), requestDeletion, cancelDeletion };
    render(<ArchiveView />);
    set(reading(), actions);

    const trigger = screen.getByRole("button", { name: "Delete conversation" });
    await user.click(trigger);

    expect(requestDeletion).toHaveBeenCalledWith(NEWER);
    const dialog = screen.getByRole("dialog", { name: "Delete this conversation?" });
    expect(dialog).toHaveTextContent(
      "This permanently removes this past conversation and its original attachments from this computer. Imported activities in Training and work in Plan stay.",
    );
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Delete conversation"]);
    await waitFor(() => expect(buttons[0]).toHaveFocus());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancelDeletion).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("keeps deletion modal while busy and offers an explicit retry after failure", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    render(<ArchiveView />);
    set(
      {
        ...reading(),
        deletion: { boundaryRef: NEWER, status: "deleting" },
      },
      actions,
    );

    let dialog = screen.getByRole("dialog", { name: "Delete this conversation?" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Delete conversation" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Delete this conversation?" })).toBeInTheDocument();
    expect(actions.cancelDeletion).not.toHaveBeenCalled();

    set(
      {
        ...reading(),
        deletion: { boundaryRef: NEWER, status: "failed" },
      },
      actions,
    );
    dialog = screen.getByRole("dialog", { name: "Delete this conversation?" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Deletion could not finish. Try again to complete it.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(actions.confirmDeletion).toHaveBeenCalledOnce();
  });
});

describe("past chats navigation", () => {
  it("reaches the read-only surface from the sidebar without touching the chat view", async () => {
    const user = userEvent.setup();
    const actions = archiveActions();
    useEnduragentStore.setState({ archive: LISTED, archiveActions: actions });
    render(<Shell onReady={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Past chats" }));

    expect(await screen.findByRole("region", { name: "Past chats" })).toBeInTheDocument();
    expect(useEnduragentStore.getState().activeView).toBe("archive");
    expect(document.querySelector('[data-view="archive"]')).not.toBeNull();
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(useEnduragentStore.getState().chat).toEqual({
      ...EMPTY_CHAT_SURFACE,
      newConversationUnavailable: false,
    });

    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(useEnduragentStore.getState().activeView).toBe("chat");
  });
});

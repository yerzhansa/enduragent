import type {
  ListPlansResult,
  PlanChangeModel,
  PlanChangeWorkout,
  PlanCreationCardModel,
} from "@enduragent/coach-contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { ChatView } from "../src/ui/chat/ChatView";
import { PlanChangeCards } from "../src/ui/chat/PlanChangeCards";

function stubActions(): ChatActions {
  return {
    openPlanChangeEditor: vi.fn(),
    backFromPlanChangeEditor: vi.fn(),
    previewPlanChange: vi.fn(),
    applyPlanChange: vi.fn(),
    submit: vi.fn(async () => true),
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
    removeQueued: vi.fn(),
    runQueuedCommand: vi.fn(),
    retryQueuedTurn: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    retryDecision: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
    answerDecision: vi.fn(),
    skipDecision: vi.fn(),
  };
}

const active: NonNullable<ListPlansResult["active"]> = {
  planId: "active-change",
  version: 7,
  name: "Build steady power",
  start: "1998-09-07",
  end: "1998-10-04",
  weeks: 4,
  status: "active",
  closeReason: null,
  closedAt: null,
  activatedAt: "1998-09-07",
  calendar: { status: "pending", window: null, currentThrough: null, error: null },
  creationId: null,
};
const workout: PlanChangeWorkout = {
  id: "workout-one",
  name: "Endurance ride",
  kind: "endurance",
  date: "1998-09-09",
  minutes: 60,
  pinned: false,
  guidance: "Ride comfortably",
  power: null,
};
function change(patch: Partial<PlanChangeModel> = {}): PlanChangeModel {
  return {
    changeId: "change-pending",
    planId: active.planId,
    baseRevisionNumber: 1,
    status: "pending",
    title: "Limit Wednesday training",
    intent: { kind: "weekday-duration", day: 3, minutes: 30 },
    diff: [{ workoutId: workout.id, before: workout, after: { ...workout, minutes: 30 } }],
    totals: {
      before: { plan: 1234, weeks: [{ number: 1, minutes: 321 }] },
      after: { plan: 1204, weeks: [{ number: 1, minutes: 291 }] },
    },
    supersedes: null,
    supersededBy: null,
    resultRevisionNumber: null,
    confidence: "Confirmed schedule limits",
    premises: [
      {
        id: "premise-one",
        label: "Wednesday limit",
        source: "Your confirmed request",
        value: { kind: "weekday-duration", day: 3, minutes: 30 },
      },
    ],
    ...patch,
  };
}
function setChanges(changes: PlanChangeModel[]): void {
  act(() =>
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          active,
          creation: null,
          closed: [],
          changes,
        },
      },
    }),
  );
}
function patchChange(
  patch: Partial<ReturnType<typeof useEnduragentStore.getState>["planChange"]>,
): void {
  act(() =>
    useEnduragentStore.setState({
      planChange: { ...useEnduragentStore.getState().planChange, ...patch },
    }),
  );
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: EMPTY_CHAT_SURFACE,
    chatActions: stubActions(),
    planChange: {
      open: true,
      planId: active.planId,
      editorOpen: false,
      busy: false,
      error: null,
      notice: null,
      focusRequest: null,
    },
    planLibrary: {
      status: "ready",
      value: {
        calendarConnected: false,
        legacy: null,
        active,
        creation: null,
        closed: [],
        changes: [],
      },
    },
    planLibraryActions: null,
  });
});

describe("Plan Change cards", () => {
  it("restores pending Changes in Chat alongside separate creation and an enabled composer", async () => {
    const creation: PlanCreationCardModel = {
      creationId: "separate-creation",
      version: 1,
      status: "in-progress",
      readiness: "incomplete",
      draft: null,
      draftStale: false,
      answeredSummaries: [],
      openQuestion: null,
    };
    useEnduragentStore.setState({
      runtimeReady: true,
      onboarding: READY_ONBOARDING,
      chat: {
        ...EMPTY_CHAT_SURFACE,
        planCreation: creation,
        planCreationLoaded: true,
        planCreationPaused: true,
        timeline: [{ kind: "plan-creation", model: creation }],
      },
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          active,
          creation,
          closed: [],
          changes: [change()],
        },
      },
    });
    patchChange({ open: false, planId: null });
    render(<ChatView />);
    expect(screen.getByRole("region", { name: "Plan Changes" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plan Creation progress" })).toBeVisible();
    expect(screen.getByText("Your separate Plan creation is still open.")).toBeVisible();
    expect(screen.getByText("Training changes need your confirmation.")).toBeVisible();
    const composer = screen.getByRole("combobox", { name: "Message your coach" });
    expect(composer).toBeEnabled();
    await userEvent.type(composer, "How should I pace tomorrow?");
    expect(composer).toHaveValue("How should I pace tomorrow?");
  });

  it("shows the active Plan only after entry and restores a pending preview without entry", () => {
    patchChange({ open: false, planId: null });
    const view = render(<PlanChangeCards />);
    expect(screen.queryByRole("region", { name: "Plan Changes" })).toBeNull();
    setChanges([change()]);
    expect(screen.getByRole("heading", { name: active.name })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Limit Wednesday training" })).toBeVisible();
    expect(screen.getByText("Changes affect future, uncompleted training.")).toBeVisible();
    view.unmount();
    render(<PlanChangeCards />);
    expect(screen.getByText("Pending", { exact: true })).toBeVisible();
  });

  it("orders notice, active Plan, editor, pending preview, then oldest to newest history", () => {
    setChanges([
      change({ changeId: "old", title: "Old decision", status: "applied" }),
      change({ changeId: "new", title: "New decision", status: "cancelled" }),
      change(),
    ]);
    patchChange({ editorOpen: true, notice: "Review the exact changes before confirming." });
    render(<PlanChangeCards />);
    const surface = screen.getByRole("region", { name: "Plan Changes" });
    const headings = within(surface)
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      active.name,
      "What needs to change?",
      "Limit Wednesday training",
      "Old decision",
      "New decision",
    ]);
    expect(
      screen
        .getByText("Review the exact changes before confirming.")
        .compareDocumentPosition(screen.getByRole("heading", { name: active.name })),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("Applied", { exact: true })).toBeVisible();
    expect(screen.getByText("Cancelled", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Undo|Refresh preview/ })).toBeNull();
  });

  it("offers the five Schedule changes in order and submits their defaults", async () => {
    patchChange({ editorOpen: true });
    render(<PlanChangeCards />);
    const actions = useEnduragentStore.getState().chatActions;
    const select = screen.getByRole("combobox", { name: "Change" });
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Wed");
    expect(screen.getByRole("spinbutton", { name: "Duration limit in minutes" })).toHaveValue(30);
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekday-duration",
      day: 3,
      minutes: 30,
    });
    await userEvent.click(select);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Weekday duration cap",
      "Weekday unavailable",
      "No hard training on a weekday",
      "Weekly duration cap",
      "Longest-Workout cap",
    ]);
    await userEvent.click(await screen.findByRole("option", { name: "Weekday unavailable" }));
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Wed");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekday-unavailable",
      day: 3,
    });
    await userEvent.click(select);
    await userEvent.click(
      await screen.findByRole("option", { name: "No hard training on a weekday" }),
    );
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Mon");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({ kind: "hard-weekday", day: 1 });
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Weekly duration cap" }));
    expect(screen.queryByRole("combobox", { name: "Weekday" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveAttribute(
      "min",
      "0.25",
    );
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveAttribute(
      "step",
      "0.25",
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekly-duration",
      hours: 3,
    });
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Longest-Workout cap" }));
    expect(screen.getByRole("spinbutton", { name: "Duration limit in minutes" })).toHaveValue(60);
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "longest-workout",
      minutes: 60,
    });
  });

  it("shows host totals and both null and undated sides with the changed after name", () => {
    setChanges([
      change({
        diff: [
          {
            workoutId: "renamed",
            before: workout,
            after: { ...workout, name: "Easy recovery", minutes: 30 },
          },
          { workoutId: "added", before: null, after: { ...workout, id: "added", date: null } },
          { workoutId: "removed", before: { ...workout, id: "removed", date: null }, after: null },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    const differences = screen.getByRole("table", { name: "Affected individual Workouts" });
    expect(within(differences).getByText(/Easy recovery/)).toBeVisible();
    expect(within(differences).getAllByText(/Not in Plan/)).toHaveLength(2);
    expect(within(differences).getAllByText(/Undated/)).toHaveLength(2);
    const totals = screen.getByRole("table", { name: "Before and after totals" });
    expect(
      within(totals)
        .getAllByRole("rowheader")
        .map((row) => row.textContent),
    ).toEqual(["Plan totals", "Week 1"]);
    expect(totals).toHaveTextContent("1234 min → 1204 min");
    expect(totals).toHaveTextContent("321 min → 291 min");
    expect(screen.getByText("Main Goal", { exact: true })).toBeVisible();
    expect(screen.getByText("Confidence", { exact: true })).toBeVisible();
    expect(screen.getByText("Confirmed schedule limits", { exact: true })).toBeVisible();
  });

  it("reads current and historical evidence and differences without mutation actions", async () => {
    setChanges([
      change({ changeId: "old", title: "Earlier limit", status: "superseded" }),
      change(),
    ]);
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    let source = screen.getByRole("region", { name: "Source details" });
    expect(
      within(source).getByRole("rowheader", { name: "Wednesday limit · Your confirmed request" }),
    ).toBeVisible();
    expect(source).toHaveTextContent("Your confirmed request");
    await userEvent.click(within(source).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("region", { name: "Source details" })).toBeNull();
    expect(screen.getByText("Superseded", { exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Read historical evidence" }));
    source = screen.getByRole("region", { name: "Source details" });
    await userEvent.click(within(source).getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Read this difference" }));
    const history = screen.getByRole("region", { name: "Source details" });
    expect(
      within(history).getByRole("table", { name: "Affected individual Workouts" }),
    ).toBeVisible();
    expect(within(history).queryByRole("button", { name: "Apply to Plan" })).toBeNull();
    expect(within(history).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("moves focus to the editor, back to Change one thing, and to a new preview heading", async () => {
    const actions = stubActions();
    actions.openPlanChangeEditor = vi.fn(() =>
      patchChange({ editorOpen: true, focusRequest: { target: "editor", revision: 1 } }),
    );
    actions.backFromPlanChangeEditor = vi.fn(() =>
      patchChange({ editorOpen: false, focusRequest: { target: "change", revision: 2 } }),
    );
    actions.applyPlanChange = vi.fn(() => {
      setChanges([change({ status: "cancelled" })]);
      patchChange({ busy: true, focusRequest: { target: "change", revision: 4 } });
    });
    useEnduragentStore.setState({ chatActions: actions });
    render(<PlanChangeCards />);
    const entry = screen.getByRole("button", { name: "Change one thing" });
    await userEvent.click(entry);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Change" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(entry).toHaveFocus());
    setChanges([change()]);
    patchChange({ focusRequest: { target: "preview", revision: 3 } });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Limit Wednesday training" })).toHaveFocus(),
    );
    const preview = screen.getByRole("region", { name: "Limit Wednesday training" });
    expect(
      within(preview)
        .getAllByRole("button")
        .slice(-2)
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Apply to Plan"]);
    await userEvent.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(actions.applyPlanChange).toHaveBeenCalledWith("cancel");
    expect(entry).toBeDisabled();
    expect(entry).not.toHaveFocus();
    patchChange({ busy: false });
    await waitFor(() => expect(entry).toHaveFocus());
  });

  it.each([
    "Review the exact changes before confirming.",
    "This preview supersedes “Earlier limit”. Training is unchanged until confirmation.",
    "Change applied locally. Training now matches the confirmed preview.",
    "Change cancelled. Training is unchanged; the preview remains in history.",
    "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.",
    "This preview is no longer pending. Training is unchanged.",
    "This Change could not be applied. Training and the pending preview are unchanged.",
  ])("announces %s", (notice) => {
    patchChange({ notice });
    render(<PlanChangeCards />);
    expect(screen.getByRole("status")).toHaveTextContent(notice);
  });

  it("renders parameter errors as alerts and disables submission while busy", () => {
    patchChange({ editorOpen: true, error: "Enter a duration above zero.", busy: true });
    render(<PlanChangeCards />);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a duration above zero.");
    expect(screen.getByRole("button", { name: "Preview change" })).toBeDisabled();
  });
});

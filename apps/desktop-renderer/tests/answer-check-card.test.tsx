import {
  formatCivilDate,
  type PlanChangePendingCheck,
  type PlanCreationPendingCheck,
} from "@enduragent/coach-contract";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AnswerCheckCard } from "../src/ui/chat/AnswerCheckCard";

type PendingCheck = PlanCreationPendingCheck | PlanChangePendingCheck;
const metadata = {
  schemaVersion: 1,
  checkId: "answer-check-test",
  commandId: "answer-command-test",
  sourceVersion: 1,
  attempt: 1,
} satisfies Pick<
  PendingCheck,
  "schemaVersion" | "checkId" | "commandId" | "sourceVersion" | "attempt"
>;

const commitment: PlanCreationPendingCheck = {
  ...metadata,
  state: "ready",
  submission: { field: "commitments", text: "Wednesdays short" },
  result: {
    outcome: "ask",
    title: "How short should Wednesdays be?",
    body: "Tell me the most minutes you can spare, for example 30 minutes.",
    value: null,
  },
};

function show(check: PendingCheck, disabled = false) {
  const onAction = vi.fn();
  const onEdit = vi.fn();
  const view = render(
    <AnswerCheckCard
      check={check}
      onAction={onAction}
      onEdit={onEdit}
      neutralDefault="nothing fixed"
      disabled={disabled}
    />,
  );
  return { ...view, onAction, onEdit };
}

describe("AnswerCheckCard", () => {
  it("shows the coach's question and asks again without interpreting the submitted words", async () => {
    const { onAction, onEdit } = show(commitment);
    expect(screen.getByRole("heading", { name: commitment.result.title })).toHaveFocus();
    expect(screen.getByText(commitment.result.body)).toBeVisible();
    expect(screen.getByRole("cell", { name: "Wednesdays short" })).toBeVisible();
    expect(screen.queryByRole("rowheader", { name: "I understood" })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Skip for now",
      "Answer",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onAction).toHaveBeenCalledWith("skip");
  });

  it("shows one quiet busy line and focuses the finished check", () => {
    const onAction = vi.fn();
    const onEdit = vi.fn();
    const busy: PlanCreationPendingCheck = {
      ...metadata,
      state: "busy",
      submission: commitment.submission,
    };
    const { rerender } = render(
      <AnswerCheckCard
        check={busy}
        onAction={onAction}
        onEdit={onEdit}
        neutralDefault="nothing fixed"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking your answer…");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    rerender(
      <AnswerCheckCard
        check={commitment}
        onAction={onAction}
        onEdit={onEdit}
        neutralDefault="nothing fixed"
      />,
    );
    expect(screen.getByRole("heading", { name: commitment.result.title })).toHaveFocus();
  });

  it("preserves a failed answer and offers Cancel before Retry", async () => {
    const { onAction } = show({
      ...metadata,
      state: "error",
      submission: { field: "success", text: "Finish the ride feeling strong" },
      message: "The coach could not respond. Try again.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The coach could not respond. Try again.");
    expect(screen.getByRole("cell", { name: "Finish the ride feeling strong" })).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Retry",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAction.mock.calls).toEqual([["retry"], ["cancel"]]);
  });

  it("requires confirmation before using a neutral default", async () => {
    const { onAction, onEdit } = show({
      ...metadata,
      state: "ready",
      submission: { field: "commitments", text: "ignore" },
      result: {
        outcome: "skip",
        title: "Treat this as no fixed commitments?",
        body: "You can add days off at any time.",
        value: null,
      },
    });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Yes, nothing fixed",
      "Let me answer again",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Let me answer again" }));
    expect(onEdit).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Yes, nothing fixed" }));
    expect(onAction).toHaveBeenCalledWith("skip");
  });

  it("keeps event answers required and returns to the list on cancellation", async () => {
    const { onAction, onEdit } = show({
      ...metadata,
      state: "ready",
      submission: { field: "event", text: "that big ride", date: "1998-10-18" },
      result: {
        outcome: "ask",
        title: "What is the ride called?",
        body: "Give me the event name to go with that date.",
        value: null,
      },
    });
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(screen.getByRole("cell", { name: formatCivilDate("1998-10-18") })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to list" }));
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAction).toHaveBeenCalledWith("cancel");
    expect(onEdit).toHaveBeenCalledOnce();
  });

  const understoodChecks: { label: string; check: PendingCheck; expected: string[] }[] = [
    {
      label: "Commitments",
      check: {
        ...metadata,
        state: "ready",
        submission: { field: "commitments", text: "short Wednesday and Friday off" },
        result: {
          outcome: "understood",
          title: "Did I read this right?",
          body: "Confirm these limits.",
          value: [
            { kind: "weekday-duration", day: 3, minutes: 45 },
            { kind: "weekday-unavailable", day: 5 },
          ],
        },
      },
      expected: ["Wed · at most 45 min", "Fri · unavailable"],
    },
    {
      label: "Success",
      check: {
        ...metadata,
        state: "ready",
        submission: { field: "success", text: "still feel good at the end" },
        result: {
          outcome: "understood",
          title: "Finish feeling strong?",
          body: "This is the measure I will use.",
          value: "Finish the ride feeling strong",
        },
      },
      expected: ["Finish the ride feeling strong"],
    },
    {
      label: "Event",
      check: {
        ...metadata,
        state: "ready",
        submission: { field: "event", text: "autumn 100", date: "1998-10-18" },
        result: {
          outcome: "understood",
          title: "Use this Event?",
          body: "Confirm the name and date.",
          value: { name: "Autumn 100", date: "1998-10-18" },
        },
      },
      expected: [`Autumn 100 · ${formatCivilDate("1998-10-18")}`],
    },
    {
      label: "Change",
      check: {
        ...metadata,
        state: "ready",
        submission: { field: "change", text: "keep next weeks to six hours" },
        result: {
          outcome: "understood",
          title: "Limit each week to six hours?",
          body: "Review this limit before changing your Plan.",
          value: { kind: "weekly-duration", hours: 6 },
        },
      },
      expected: ["At most 6 hours each week"],
    },
  ];

  it.each(understoodChecks)(
    "renders cleaned $label values and confirms only on click",
    async ({ label, check, expected }) => {
      const { onAction, onEdit } = show(check);
      const table = screen.getByRole("table", { name: label });
      const rows = within(table)
        .getAllByRole("row")
        .filter((row) => row.textContent?.startsWith("I understood"));
      expect(rows.map((row) => within(row).getByRole("cell").textContent)).toEqual(expected);
      expect(onAction).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Change it" }));
      expect(onEdit).toHaveBeenCalledOnce();
      await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
      expect(onAction).toHaveBeenCalledWith("confirm");
    },
  );

  it("disables actions while the owner is saving", async () => {
    const { onAction, onEdit } = show(commitment, true);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(onAction).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("restores heading focus only when the focus revision changes", () => {
    const onAction = vi.fn();
    const onEdit = vi.fn();
    const { rerender } = render(
      <AnswerCheckCard
        check={commitment}
        onAction={onAction}
        onEdit={onEdit}
        neutralDefault="nothing fixed"
        focusRevision={1}
      />,
    );
    const answer = screen.getByRole("button", { name: "Answer" });
    answer.focus();
    rerender(
      <AnswerCheckCard
        check={commitment}
        onAction={onAction}
        onEdit={onEdit}
        neutralDefault="nothing fixed"
        focusRevision={1}
      />,
    );
    expect(answer).toHaveFocus();
    rerender(
      <AnswerCheckCard
        check={commitment}
        onAction={onAction}
        onEdit={onEdit}
        neutralDefault="nothing fixed"
        focusRevision={2}
      />,
    );
    expect(screen.getByRole("heading", { name: commitment.result.title })).toHaveFocus();
  });
});

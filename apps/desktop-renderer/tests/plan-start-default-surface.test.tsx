import type { PlanCreationAnswerInput, PlanCreationOpenQuestion } from "@enduragent/coach-contract";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextWeekStart } from "../src/calendar/dates";
import { regionWeekStart } from "../src/calendar/week-start";
import { rendererPlatformProjection } from "../src/platform-copy";
import { PlanCreationQuestionCard } from "../src/ui/chat/PlanCreationQuestionCard";
import { renderLocalized } from "./language-harness";

const THURSDAY = "1998-10-01";

const question: PlanCreationOpenQuestion = {
  kind: "start-timing-question",
  step: { current: 5, total: 9 },
  prompt: "When should this Plan start?",
  earliestAllowed: THURSDAY,
  options: [
    {
      timing: "first-day-of-week",
      label: "First day of your week",
      detail: "One calendar row is one Training Week.",
    },
    { timing: "earliest", label: "Pick another day", detail: "Start on that day." },
  ],
  dateLabel: "Plan starts",
};

function regionStartsOn(firstDayOfWeek: 1 | 6 | 7) {
  vi.stubGlobal("enduragentAuth", {
    platform: { ...rendererPlatformProjection(), firstDayOfWeek },
  });
}

function show(currentAnswer: PlanCreationAnswerInput | null = null, asked = question) {
  const onAnswer = vi.fn();
  renderLocalized(
    <PlanCreationQuestionCard
      question={asked}
      currentAnswer={currentAnswer}
      editing={false}
      busy={false}
      error={null}
      focusRevision={0}
      onAnswer={onAnswer}
      onLater={vi.fn()}
      onCancel={vi.fn()}
      onEditorOpenChange={vi.fn()}
    />,
  );
  return onAnswer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the default Plan start", () => {
  it.each([
    [1, "Mon 5 Oct", "1998-10-05"],
    [7, "Sun 4 Oct", "1998-10-04"],
    [6, "Sat 3 Oct", "1998-10-03"],
  ] as const)(
    "offers the next first day of the region's week (%i) and answers it as the start",
    async (firstDay, label, date) => {
      const user = userEvent.setup();
      regionStartsOn(firstDay);
      const onAnswer = show();
      const choice = screen.getByRole("button", { name: label });
      expect(choice).toHaveTextContent("First day of your week");
      await user.click(choice);
      expect(onAnswer).toHaveBeenCalledWith({
        kind: "start-timing",
        timing: { kind: "earliest", date },
      });
    },
  );

  it("lets the athlete pick another day", async () => {
    const user = userEvent.setup();
    const onAnswer = show();
    await user.click(screen.getByRole("button", { name: "Pick another day" }));
    const day = screen.getByLabelText("Plan starts");
    expect(day).toHaveAttribute("min", THURSDAY);
    await user.type(day, "1998-10-08");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAnswer).toHaveBeenCalledWith({
      kind: "start-timing",
      timing: { kind: "earliest", date: "1998-10-08" },
    });
  });

  it("marks the default as chosen when the answer is the first day of the week", () => {
    show({ kind: "start-timing", timing: { kind: "earliest", date: "1998-10-05" } });
    expect(screen.getByRole("button", { name: "Mon 5 Oct" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("Plan starts")).toBeNull();
  });

  it("still shows a start question stored before the first-day option existed", () => {
    show(null, {
      ...question,
      options: [
        { timing: "as-soon-as-possible", label: "As soon as possible", detail: "Start now." },
        { timing: "earliest", label: "Pick another day", detail: "Start on that day." },
      ],
    });
    expect(screen.getByRole("button", { name: "Mon 5 Oct" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick another day" })).toBeInTheDocument();
  });

  it("finds the first day of the week from any day, keeping a day that already is one", () => {
    expect(nextWeekStart(19981001, 1)).toBe(19981005);
    expect(nextWeekStart(19981005, 1)).toBe(19981005);
    expect(nextWeekStart(19981004, 7)).toBe(19981004);
    expect(nextWeekStart(19981004, 6)).toBe(19981010);
    expect(regionWeekStart("1998-12-29", 1)).toBe("1999-01-04");
  });
});

import { renderLocalized as render } from "./language-harness";
import type { PlanHistoryResult } from "@enduragent/coach-contract";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanFinalDetails } from "../src/ui/plan/PlanFinalDetails";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

function history(): NonNullable<PlanHistoryResult> {
  const draft = planCreationDraft([
    {
      answerKey: "plan-length",
      title: "Plan length",
      detail: "4 weeks",
      source: { kind: "athlete" },
      answer: { kind: "plan-length", weeks: 4 },
      question: {
        kind: "plan-length-question",
        step: { current: 2, total: 9 },
        prompt: "How long should this Plan be?",
        options: ([4, 8, 12, 16] satisfies Array<4 | 8 | 12 | 16>).map((weeks) => ({
          weeks,
          label: `${weeks} weeks`,
          detail: `${weeks} weeks of training`,
        })),
      },
    },
  ]);
  return {
    plan: {
      planId: "closed-plan",
      version: 2,
      name: "Build steady power",
      start: draft.start,
      end: draft.end,
      weeks: draft.weeks.length,
      status: "closed",
      closeReason: "stopped",
      closedAt: "1998-09-14",
      activatedAt: "1998-09-07",
      calendar: { status: "pending", window: null, currentThrough: null, error: null },
      creationId: "creation-closed",
    },
    closeActor: "fictional-device",
    revision: { revisionNumber: 1, fingerprint: draft.outputFingerprint, snapshot: draft },
    cleanup: "pending",
  };
}

describe("final Plan details", () => {
  it("renders the notice, closed summary, Draft facts and every week with only Back to library", () => {
    const backToLibrary = vi.fn();
    render(
      <PlanFinalDetails
        history={history()}
        notice="Plan closed. Calendar cleanup pending."
        backToLibrary={backToLibrary}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Plan closed. Calendar cleanup pending.");
    const closed = screen.getByRole("region", { name: "Closed Plan" });
    expect(within(closed).getByRole("heading", { name: "Build steady power" })).toBeVisible();
    expect(within(closed).getByText("Closed")).toBeVisible();
    expect(closed).toHaveTextContent("7 Sept 1998 to 4 Oct 1998 · 4 weeks · Stopped");
    const details = screen.getByRole("region", { name: "Final Plan details" });
    const facts = within(details).getByRole("table", { name: "Draft inputs" });
    expect(
      within(facts).getByRole("row", { name: /Main Goal · your answer.*Build steady power/ }),
    ).toBeVisible();
    expect(
      within(facts).getByRole("row", { name: /Plan length · your answer.*4 weeks/ }),
    ).toBeVisible();
    expect(within(facts).getByRole("row", { name: /Plan span/ })).toHaveTextContent(
      "7 Sept 1998 to 4 Oct 1998 · 4 weeks · Fitness Plan",
    );
    for (const number of [1, 2, 3, 4]) {
      expect(within(details).getByRole("list", { name: `Week ${number} Workouts` })).toBeVisible();
    }
    expect(within(details).getByText("No Workouts this week.")).toBeVisible();
    expect(
      within(details).getByText("Confirmed limits leave no Workouts in this week."),
    ).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Back to library",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(backToLibrary).toHaveBeenCalledOnce();
  });

  it.each([
    ["completed", "Completed"],
    ["stopped", "Stopped"],
    ["legacy-unclassified", "Unknown reason"],
    [null, "Unknown reason"],
  ] satisfies ReadonlyArray<
    readonly [NonNullable<PlanHistoryResult>["plan"]["closeReason"], string]
  >)("renders %s as %s", (closeReason, label) => {
    const value = history();
    value.plan.closeReason = closeReason;
    render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Closed Plan" })).toHaveTextContent(
      `7 Sept 1998 to 4 Oct 1998 · 4 weeks · ${label}`,
    );
  });

  it.each([
    ["complete", "Cleanup complete"],
    ["pending", "Calendar cleanup pending"],
    ["failed", "Calendar cleanup pending"],
    ["none", "Final history"],
  ] satisfies ReadonlyArray<readonly [NonNullable<PlanHistoryResult>["cleanup"], string]>)(
    "renders the Calendar row for %s cleanup",
    (cleanup, label) => {
      const value = history();
      value.cleanup = cleanup;
      Reflect.deleteProperty(value.plan, "calendar");
      render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
      expect(
        within(screen.getByRole("row", { name: /^Calendar/ })).getByRole("cell", { name: label }),
      ).toBeVisible();
    },
  );

  it.each([
    [
      { status: "verified", window: null, currentThrough: "1998-09-13", error: null },
      "Cleanup complete",
    ],
    [
      { status: "pending", window: null, currentThrough: null, error: null },
      "Calendar cleanup pending",
    ],
    [
      { status: "running", window: null, currentThrough: null, error: null },
      "Calendar cleanup pending",
    ],
    [
      { status: "not-connected", window: null, currentThrough: null, error: null },
      "Calendar cleanup waits for intervals.icu",
    ],
    [
      {
        status: "failed",
        window: null,
        currentThrough: null,
        error: "Calendar cleanup failed. Retry available.",
      },
      "Calendar cleanup failed. Retry available.",
    ],
    [
      { status: "failed", window: null, currentThrough: null, error: "Calendar cleanup failed." },
      "Calendar cleanup failed.",
    ],
  ] satisfies Array<[NonNullable<PlanHistoryResult>["plan"]["calendar"], string]>)(
    "prefers calendar %j over cleanup",
    (calendar, copy) => {
      const value = history();
      value.plan.calendar = calendar;
      value.cleanup = "none";
      render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
      expect(screen.getByRole("row", { name: /^Calendar/ })).toHaveTextContent(copy);
      expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(
        calendar.status === "failed" && calendar.error.endsWith("Retry available.")
          ? ["Retry calendar", "Back to library"]
          : ["Back to library"],
      );
    },
  );

  it("offers the calendar retry action only while cleanup remains retryable", () => {
    const value = history();
    value.plan.calendar = {
      status: "failed",
      window: null,
      currentThrough: null,
      error: "Calendar cleanup failed. Retry available.",
    };
    const retryCalendar = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <PlanFinalDetails history={value} backToLibrary={vi.fn()} retryCalendar={retryCalendar} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry calendar" }));
    expect(retryCalendar).toHaveBeenCalledOnce();
    value.plan.calendar = {
      status: "verified",
      window: null,
      currentThrough: "1998-09-13",
      error: null,
    };
    view.rerender(
      <PlanFinalDetails history={value} backToLibrary={vi.fn()} retryCalendar={retryCalendar} />,
    );
    expect(screen.queryByRole("button", { name: "Retry calendar" })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Calendar/ })).toHaveTextContent("Cleanup complete");
  });

  it("retains undated Workouts as Not chosen and preserves dated and pinned Workouts", () => {
    const value = history();
    const firstWeek = value.revision.snapshot.weeks[0];
    if (firstWeek === undefined) throw new Error("Missing first week");
    firstWeek.workouts = [
      {
        id: "unchosen",
        name: "Unchosen ride",
        kind: "endurance",
        date: null,
        minutes: 60,
        pinned: false,
        guidance: "Comfortable effort",
        power: null,
      },
      {
        id: "dated",
        name: "Dated ride",
        kind: "endurance",
        date: "1998-09-08",
        minutes: 40,
        pinned: false,
        guidance: "Comfortable effort",
        power: null,
      },
      {
        id: "pinned",
        name: "Pinned ride",
        kind: "event",
        date: "1998-09-12",
        minutes: 90,
        pinned: true,
        guidance: "Comfortable effort",
        power: null,
      },
      {
        id: "undated-pinned",
        name: "Undated pinned ride",
        kind: "endurance",
        date: null,
        minutes: 20,
        pinned: true,
        guidance: "Comfortable effort",
        power: null,
      },
    ];
    render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
    const rows = within(screen.getByRole("list", { name: "Week 1 Workouts" })).getAllByRole(
      "listitem",
    );
    expect(rows[0]).toHaveTextContent("Priority 1 · Undated");
    expect(rows[0]).toHaveTextContent("Not chosen");
    expect(rows[1]).toHaveTextContent("8 Sept 1998");
    expect(rows[1]).toHaveTextContent("planned");
    expect(rows[2]).toHaveTextContent("12 Sept 1998");
    expect(rows[2]).toHaveTextContent("planned · Pinned");
    expect(rows[3]).toHaveTextContent("Priority 4 · Undated");
    expect(rows[3]).toHaveTextContent("planned · Pinned");
    expect(firstWeek.workouts.map((workout) => workout.date)).toEqual([
      null,
      "1998-09-08",
      "1998-09-12",
      null,
    ]);
  });

  it("invites a new event preparation Plan when the Event Goal is beyond the Plan end", () => {
    const value = history();
    value.revision.snapshot.goal = { kind: "event", name: "Spring ride", date: "1999-02-14" };
    value.revision.snapshot.spanKind = "Base Plan";
    render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
    expect(
      within(screen.getByRole("region", { name: "Closed Plan" })).getByRole("status"),
    ).toHaveTextContent(
      "Your Event Goal is still 14 Feb 1999. Start a new Plan for event preparation when it is within 24 weeks.",
    );
    expect(
      screen.getByRole("row", { name: /Main Goal · your answer.*Spring ride · 14 Feb 1999/ }),
    ).toBeVisible();
  });

  it.each(["1998-10-03", "1998-10-04"])(
    "omits the event invitation for Goal date %s within the Plan",
    (date) => {
      const value = history();
      value.revision.snapshot.goal = { kind: "event", name: "Autumn ride", date };
      render(<PlanFinalDetails history={value} backToLibrary={vi.fn()} />);
      expect(screen.queryByText(/Your Event Goal is still/)).not.toBeInTheDocument();
    },
  );
});

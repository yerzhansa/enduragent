import { renderLocalized as render, renderWithCatalog } from "./language-harness";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PlanningReadModel } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEnduragentStore } from "../src/state/store";
import { PlanReferenceCard } from "../src/ui/chat/PlanReferenceCard";

const model: PlanningReadModel = {
  schemaVersion: 1,
  status: "ready",
  asOfDateKey: 19980826,
  plan: {
    id: "plan-1",
    name: "Twelve-week base",
    goal: "Build consistency",
    lifecycle: "active",
    startDateKey: 19980824,
    targetDateKey: null,
    currentWeek: 1,
    totalWeeks: 12,
    phase: "Base",
    weekStartDateKey: 19980824,
    weekEndDateKey: 19980830,
    workouts: [
      {
        id: "workout-1",
        dateKey: 19980826,
        sport: "cycling",
        name: "Tempo builder",
        durationSeconds: 3_600,
        targets: "3 × 8 min · 85–90% FTP",
        purpose: "Sustainable power",
        safetyGuardrail: "Stop if the warm-up feels wrong",
        origin: "coach",
        navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
      },
    ],
    todayWorkout: null,
    navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
  },
};

afterEach(() => {
  act(() =>
    useEnduragentStore.setState({
      planSurface: { status: "loading", value: null },
      planningReadActions: null,
    }),
  );
});

describe("Plan reference card", () => {
  it("reads Plan reference labels and actions from an injected Italian catalog", async () => {
    useEnduragentStore.setState((state) => ({
      settings: { ...state.settings, language: { status: "ready", value: "it" } },
    }));
    useEnduragentStore.setState({ planSurface: { status: "ready", value: model } });
    await renderWithCatalog(
      <PlanReferenceCard selection={{ kind: "current_week", planId: "plan-1", weekNumber: 1 }} />,
      {
        chat: {
          planReference: {
            currentWeek: "Settimana corrente",
            weekTitle: "Settimana {{week}} di {{total}}",
            openPlan: "Apri piano",
            minutes: "{{minutes}} minuti",
          },
        },
      },
    );
    expect(screen.getByRole("heading", { name: "Settimana 1 di 12" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apri piano" })).toBeInTheDocument();
    expect(screen.getByText("60 minuti")).toBeInTheDocument();
    expect(screen.getByText("Tempo builder")).toBeInTheDocument();
  });

  it("renders the frozen Workout fields and opens the typed Plan destination", async () => {
    const openFromChat = vi.fn();
    act(() =>
      useEnduragentStore.setState({
        planSurface: { status: "ready", value: model },
        planningReadActions: {
          refresh: vi.fn(),
          openFromChat,
          backToChat: vi.fn(),
          returnToChatRequest: vi.fn(),
        },
      }),
    );
    const user = userEvent.setup();
    render(
      <PlanReferenceCard
        selection={{ kind: "workout_detail", planId: "plan-1", workoutId: "workout-1" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tempo builder" })).toBeInTheDocument();
    expect(screen.getByText("3 × 8 min · 85–90% FTP")).toBeInTheDocument();
    expect(screen.getByText("Sustainable power")).toBeInTheDocument();
    expect(screen.getByText("Stop if the warm-up feels wrong")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply|save|replace/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Plan" }));
    expect(openFromChat).toHaveBeenCalledWith({
      destination: "plan",
      focus: "workout",
      entityId: "workout-1",
    });
  });

  it("renders nothing when current Plan data cannot resolve the saved selection", () => {
    act(() =>
      useEnduragentStore.setState({
        planSurface: { status: "ready", value: model },
        planningReadActions: {
          refresh: vi.fn(),
          openFromChat: vi.fn(),
          backToChat: vi.fn(),
          returnToChatRequest: vi.fn(),
        },
      }),
    );
    const view = render(
      <PlanReferenceCard
        selection={{ kind: "workout_detail", planId: "plan-1", workoutId: "missing" }}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });
  it("keeps missing duration explicit", () => {
    const plan = model.plan;
    if (plan === null) throw new Error("The fictional fixture requires a Plan");
    act(() =>
      useEnduragentStore.setState({
        planSurface: {
          status: "ready",
          value: {
            ...model,
            plan: {
              ...plan,
              workouts: plan.workouts.map((workout) => ({ ...workout, durationSeconds: null })),
            },
          },
        },
        planningReadActions: null,
      }),
    );
    render(
      <PlanReferenceCard selection={{ kind: "current_week", planId: "plan-1", weekNumber: 1 }} />,
    );
    expect(screen.getByText("Duration unavailable")).toBeInTheDocument();
    expect(screen.getByText("Tempo builder")).toBeInTheDocument();
  });

  it("shows an empty week without inventing Workout facts", () => {
    const plan = model.plan;
    if (plan === null) throw new Error("The fictional fixture requires a Plan");
    act(() =>
      useEnduragentStore.setState({
        planSurface: { status: "ready", value: { ...model, plan: { ...plan, workouts: [] } } },
        planningReadActions: null,
      }),
    );
    render(
      <PlanReferenceCard selection={{ kind: "current_week", planId: "plan-1", weekNumber: 1 }} />,
    );
    expect(screen.getByText("No workouts in this week.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Plan" })).toBeDisabled();
  });
});

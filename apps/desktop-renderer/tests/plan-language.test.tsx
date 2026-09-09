import type { PlanHistoryResult } from "@enduragent/coach-contract";
import { screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { EMPTY_PLAN_SURFACE } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanFinalDetails } from "../src/ui/plan/PlanFinalDetails";
import { PlanView } from "../src/ui/plan/PlanView";
import { renderWithCatalog } from "./language-harness";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

beforeEach(() => {
  useEnduragentStore.setState((state) => ({
    settings: {
      ...state.settings,
      language: { ...state.settings.language, status: "ready", value: "it" },
    },
    plan: EMPTY_PLAN_SURFACE,
    planActions: null,
    planLibrary: { status: "loading", value: null },
    planLibraryActions: null,
    planningReadActions: null,
  }));
});

it("reads Plan loading copy from the selected Italian catalog", async () => {
  await renderWithCatalog(<PlanView />, {
    plan: {
      view: {
        planView: {
          plan: "Piano di allenamento",
          loading: "Caricamento del piano…",
        },
      },
    },
  });
  expect(screen.getByRole("heading", { name: "Piano di allenamento" })).toBeVisible();
  expect(screen.getByText("Caricamento del piano…")).toBeVisible();
  expect(screen.queryByText("Loading Plan…")).toBeNull();
});

it("reads final Plan details copy from the selected Italian catalog", async () => {
  const history: NonNullable<PlanHistoryResult> = {
    plan: {
      planId: "closed-language-fixture",
      version: 1,
      name: "Build steady power",
      start: "1998-09-07",
      end: "1998-10-04",
      weeks: 4,
      status: "closed",
      closeReason: "completed",
      closedAt: "1998-10-04",
      activatedAt: "1998-09-07",
      calendar: { status: "pending", window: null, currentThrough: null, error: null },
      creationId: null,
    },
    closeActor: "fictional-device",
    revision: { revisionNumber: 1, fingerprint: "b".repeat(64), snapshot: planCreationDraft() },
    cleanup: "complete",
  };
  await renderWithCatalog(<PlanFinalDetails history={history} backToLibrary={vi.fn()} />, {
    plan: {
      details: {
        planFinalDetails: {
          historyLabel: "Cronologia finale del piano",
          title: "Dettagli finali del piano",
          backToLibrary: "Torna alla raccolta",
        },
      },
    },
  });
  const details = screen.getByRole("region", { name: "Cronologia finale del piano" });
  expect(within(details).getByRole("heading", { name: "Dettagli finali del piano" })).toBeVisible();
  expect(within(details).getByRole("button", { name: "Torna alla raccolta" })).toBeVisible();
  expect(screen.queryByText("Final Plan details")).toBeNull();
});

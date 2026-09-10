import type { PlanCreationCardModel, PlanCreationOpenQuestion } from "@enduragent/coach-contract";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import {
  PlanCreationActivateDialog,
  PlanCreationConversation,
  PlanCreationDiscardConsequence,
  PlanCreationDiscardDialog,
  PlanCreationDock,
} from "../src/ui/chat/PlanCreationCards";
import {
  PlanCreationCommitmentCard,
  PlanCreationDraftCards,
} from "../src/ui/chat/PlanCreationDraftCards";
import { PlanCreationQuestionCard } from "../src/ui/chat/PlanCreationQuestionCard";
import { PlanCreationSummary } from "../src/ui/chat/PlanCreationSummary";
import { useChatDate } from "../src/ui/chat/use-chat-date";
import { renderLocalized, renderWithCatalog } from "./language-harness";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

const question: PlanCreationOpenQuestion = {
  kind: "plan-length-question",
  step: { current: 1, total: 9 },
  prompt: "Choose a Plan length",
  options: [{ weeks: 4, label: "Four weeks", detail: "A short training block" }],
};

const model: PlanCreationCardModel = {
  creationId: "creation-language",
  version: 1,
  status: "in-progress",
  draft: null,
  draftStale: false,
  calendarWindow: null,
  pendingCommitment: null,
  readiness: "incomplete",
  answeredSummaries: [],
  openQuestion: question,
};

const catalog = {
  chat: {
    planCreation: {
      title: "Creazione del piano",
      progressLabel: "Avanzamento del piano",
      newPlan: "Nuovo piano",
      inProgress: "In corso",
      questionProgress: "Creazione del piano · domanda {{current}} di {{total}}",
      later: "Più tardi",
      discardTitle: "Scartare questa creazione?",
      keepCreating: "Continua a creare",
      discardCreation: "Scarta creazione",
      discarded: "Creazione scartata",
      discardConsequence: "Nessun piano è stato creato.",
      activateTitle: "Attivare il piano?",
      activateDetail: "Il nuovo piano si attiva ora.",
      activate: "Attiva piano",
      draftReview: "Revisione della bozza",
      draftInputs: "Dati della bozza",
      outlineTitle: "Ogni settimana e allenamento",
      commitmentsLabelShort: "Tabella impegni",
      didIReadThis: "Ho letto giusto?",
      confirmAction: "Conferma azione",
      youWrote: "Testo inviato",
      maximumDuration: "Durata massima in ore",
      optionalEndDate: "Data finale facoltativa",
      continue: "Continua",
      durationPositive: "Inserisci una durata maggiore di zero ore.",
    },
  },
};

beforeEach(() => {
  const state = useEnduragentStore.getState();
  useEnduragentStore.setState({
    settings: { ...state.settings, language: { status: "ready", value: "it" } },
    chat: { ...EMPTY_CHAT_SURFACE, planCreation: model, planCreationLoaded: true },
    chatActions: null,
    planLibrary: { status: "loading", value: null },
    planLibraryActions: null,
  });
});

describe("Plan creation catalog rendering", () => {
  it("reads the discard dialog from the injected Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: { ...useEnduragentStore.getState().chat, planCreationDiscardConfirmationOpen: true },
    });
    await renderWithCatalog(<PlanCreationDiscardDialog />, catalog);
    expect(screen.getByRole("dialog", { name: "Scartare questa creazione?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continua a creare" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Scarta creazione" })).toBeVisible();
  });

  it("reads the activation dialog from the injected Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: {
        ...useEnduragentStore.getState().chat,
        planCreationActivateConfirmationOpen: true,
        planCreationActivePlanKnowledge: { kind: "none" },
      },
    });
    await renderWithCatalog(<PlanCreationActivateDialog />, catalog);
    expect(screen.getByRole("dialog", { name: "Attivare il piano?" })).toBeVisible();
    expect(screen.getByText("Il nuovo piano si attiva ora.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Attiva piano" })).toBeVisible();
  });

  it("reads the dock question progress and action from the injected Italian catalog", async () => {
    await renderWithCatalog(<PlanCreationDock onEditorOpenChange={vi.fn()} />, catalog);
    expect(screen.getByText("Creazione del piano · domanda 1 di 9")).toBeVisible();
    expect(screen.getByRole("button", { name: "Più tardi" })).toBeVisible();
    expect(screen.getByRole("heading", { name: question.prompt })).toBeVisible();
  });

  it("reads the conversation section label from the injected Italian catalog", async () => {
    await renderWithCatalog(<PlanCreationConversation model={model} />, catalog);
    expect(screen.getByRole("region", { name: "Creazione del piano" })).toBeVisible();
  });

  it("reads the discard record from the injected Italian catalog", async () => {
    await renderWithCatalog(<PlanCreationDiscardConsequence eventId="discard-language" />, catalog);
    expect(screen.getByText("Creazione scartata")).toBeVisible();
    expect(screen.getByText("Nessun piano è stato creato.")).toBeVisible();
  });

  it("reads the progress summary from the injected Italian catalog", async () => {
    await renderWithCatalog(<PlanCreationSummary model={model} />, catalog);
    expect(screen.getByRole("region", { name: "Avanzamento del piano" })).toBeVisible();
    expect(screen.getByText("Nuovo piano")).toBeVisible();
    expect(screen.getByText("In corso")).toBeVisible();
  });

  it("reads draft labels from the injected Italian catalog and preserves workout data", async () => {
    const draft = planCreationDraft();
    await renderWithCatalog(
      <PlanCreationDraftCards model={{ ...model, draft }} draft={draft} onEditAnswers={vi.fn()} />,
      catalog,
    );
    expect(screen.getByRole("region", { name: "Revisione della bozza" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Dati della bozza" })).toBeVisible();
    expect(screen.getByText("Ogni settimana e allenamento")).toBeVisible();
    expect(screen.getAllByText(/Endurance ride · 60 min/)).toHaveLength(3);
  });

  it("reads the commitment review from the injected Italian catalog", async () => {
    await renderWithCatalog(
      <PlanCreationCommitmentCard
        model={{
          ...model,
          pendingCommitment: {
            text: "Tuesday unavailable",
            status: "confirm",
            rules: [{ kind: "weekday-unavailable", day: 2 }],
            unparsed: [],
          },
        }}
      />,
      catalog,
    );
    expect(screen.getByText("Ho letto giusto?")).toBeVisible();
    expect(screen.getByRole("table", { name: "Tabella impegni" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Conferma azione" })).toBeVisible();
    expect(screen.getByText("Tuesday unavailable")).toBeVisible();
  });

  it("reads question fields and validation from the injected Italian catalog", async () => {
    const restrictionQuestion: PlanCreationOpenQuestion = {
      kind: "restriction-question",
      step: { current: 9, total: 9 },
      prompt: "Any restrictions?",
      options: [{ kind: "max-duration", label: "Maximum duration", detail: "Limit the ride" }],
    };
    await renderWithCatalog(
      <PlanCreationQuestionCard
        question={restrictionQuestion}
        currentAnswer={{ kind: "restriction", restriction: { kind: "max-duration", hours: 1 } }}
        editing={false}
        busy={false}
        error={null}
        focusRevision={0}
        onAnswer={vi.fn()}
        onLater={vi.fn()}
        onCancel={vi.fn()}
        onEditorOpenChange={vi.fn()}
      />,
      catalog,
    );
    const duration = screen.getByRole("spinbutton", { name: "Durata massima in ore" });
    expect(screen.getByLabelText("Data finale facoltativa")).toBeVisible();
    fireEvent.change(duration, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Continua" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Inserisci una durata maggiore di zero ore.",
    );
  });
});

function DateExample({ value }: { readonly value: string }) {
  const formatDate = useChatDate();
  return <span>{formatDate(value)}</span>;
}

describe("Chat civil dates", () => {
  it.each([
    ["1998-01-01", "1 Jan 1998"],
    ["1998-09-07", "7 Sept 1998"],
    ["1998-12-31", "31 Dec 1998"],
    ["1998-02-30", "Unknown date"],
    ["invalid", "Unknown date"],
  ])("preserves English rendering for %s", (value, expected) => {
    renderLocalized(<DateExample value={value} />);
    expect(screen.getByText(expected)).toBeVisible();
  });
});

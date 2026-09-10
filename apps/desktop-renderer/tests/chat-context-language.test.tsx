import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithCatalog } from "./language-harness";
import { useEnduragentStore } from "../src/state/store";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { TrainingContextPanel } from "../src/ui/chat/TrainingContextPanel";
import { CoachDecisionPanel } from "../src/ui/chat/CoachDecisionPanel";

beforeEach(() => {
  useEnduragentStore.setState((state) => ({
    settings: { ...state.settings, language: { status: "ready", value: "it" } },
    chat: EMPTY_CHAT_SURFACE,
    training: { ...state.training, status: "loading" },
    planSurface: { status: "loading", value: null },
  }));
});

describe("Chat context catalogs", () => {
  it("preserves a saved custom answer even when it matches UI feedback", async () => {
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        decision: {
          status: "answered",
          decisionId: "synthetic-decision",
          chatId: "synthetic-chat",
          messageId: "synthetic-message",
          question: "Which session works?",
          options: [],
          answer: { kind: "custom", text: "Question skipped" },
          consequence: "Keep the original answer.",
          continuation: { continuationId: "synthetic-continuation", status: "pending" },
        },
        decisionPhase: "recovering",
        decisionAnswerLabel: "Question skipped",
      },
    });
    await renderWithCatalog(<CoachDecisionPanel onCustomOpenChange={vi.fn()} />, {
      chat: {
        coachDecision: { restoredAnswer: "Risposta salvata: {{answer}}" },
        notice: { questionSkipped: "Domanda saltata" },
      },
    });
    expect(screen.getByText("Risposta salvata: Question skipped")).toBeInTheDocument();
    expect(screen.queryByText(/Domanda saltata/u)).not.toBeInTheDocument();
  });

  it("reads the Training context heading, aria label and loading status from Italian", async () => {
    await renderWithCatalog(<TrainingContextPanel />, {
      chat: {
        trainingContext: {
          title: "Contesto di allenamento",
          available: "Disponibile al coach",
          loading: "Caricamento del contesto…",
        },
      },
    });
    expect(
      screen.getByRole("complementary", { name: "Contesto di allenamento" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contesto di allenamento" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Caricamento del contesto…");
    expect(screen.getByText("Disponibile al coach")).toBeInTheDocument();
  });

  it("reads the decision controls and custom answer editor from Italian while preserving coach text", async () => {
    await renderWithCatalog(
      <CoachDecisionPanel
        onCustomOpenChange={vi.fn()}
        surface={{
          decision: {
            status: "unanswered",
            decisionId: "decision-test",
            chatId: "chat-test",
            messageId: "message-test",
            question: "Which session works?",
            options: [
              {
                id: "one",
                label: "Easy ride",
                description: "Keep it light",
                recommended: true,
                consequence: "Easy today",
              },
              {
                id: "two",
                label: "Rest day",
                description: "Recover fully",
                recommended: false,
                consequence: "Rest today",
              },
            ],
          },
          phase: "idle",
          answerLabel: null,
          error: null,
          loadError: null,
          answer: vi.fn(),
          skip: vi.fn(),
          retry: vi.fn(),
        }}
      />,
      {
        chat: {
          coachDecision: {
            eyebrow: "Il coach aspetta una risposta",
            skip: "Salta domanda",
            recommended: "Consigliato",
            customLabel: "Altro",
            customDescription: "Rispondi con parole tue.",
            customPrompt: "Cosa preferisci?",
          },
        },
      },
    );
    expect(screen.getByText("Which session works?")).toBeInTheDocument();
    expect(screen.getByText("Il coach aspetta una risposta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salta domanda" })).toBeInTheDocument();
    expect(screen.getByText("Consigliato")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Altro/u }));
    expect(screen.getByLabelText("Cosa preferisci?")).toBeInTheDocument();
  });
});

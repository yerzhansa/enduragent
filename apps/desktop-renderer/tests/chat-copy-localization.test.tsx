import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { Notice, CoachProgress, RetryBar } from "../src/ui/chat/Notice";
import { SpendNotice } from "../src/ui/chat/SpendNotice";
import { chatFeedbackMessage } from "../src/ui/chat/copy";
import { renderWithCatalog } from "./language-harness";

beforeEach(() => {
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    settings: {
      ...EMPTY_SETTINGS_SURFACE,
      language: { status: "ready", value: "it" },
    },
  });
});

describe("Chat status catalog rendering", () => {
  it("renders the notice from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, notice: "Coach is working…" },
    });
    await renderWithCatalog(<Notice />, {
      chat: { notice: { working: "Il coach sta lavorando…" } },
    });
    expect(screen.getByText("Il coach sta lavorando…")).toBeVisible();
  });

  it("renders Coach progress and its accessible name from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, coachProgress: "Checking your training data…" },
    });
    await renderWithCatalog(<CoachProgress />, {
      chat: { notice: { checkingTraining: "Controllo dei dati di allenamento…" } },
    });
    expect(
      screen.getByRole("status", { name: "Controllo dei dati di allenamento…" }),
    ).toBeVisible();
  });

  it("renders retry from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, interrupted: true },
    });
    await renderWithCatalog(<RetryBar />, {
      chat: { notice: { retryMessage: "Riprova il messaggio" } },
    });
    expect(screen.getByRole("button", { name: "Riprova il messaggio" })).toBeVisible();
  });

  it("renders the spend warning from the supplied Italian catalog and formats its amount", async () => {
    const state = useEnduragentStore.getState();
    useEnduragentStore.setState({
      settings: {
        ...state.settings,
        spend: {
          ...state.settings.spend,
          warning:
            "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
          summary: {
            localDate: "1998-07-06",
            timezone: "UTC",
            dailyCapUsd: 0.5,
            knownSpendUsd: 0.6,
            generationCount: 2,
            pricedGenerationCount: 1,
            unpricedGenerationCount: 1,
            malformedLineCount: 0,
            spendComplete: false,
            capStatus: "reached",
            cacheReadTokens: 0,
            knownCacheReadSavingsUsd: 0,
            cacheSavingsComplete: false,
            routes: [],
          },
        },
      },
    });
    await renderWithCatalog(<SpendNotice />, {
      chat: { spend: { capReached: "Hai raggiunto il limite di {{amount}}." } },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Hai raggiunto il limite di 0,50 $.");
  });

  it("recognizes interpolated preview feedback without treating other text as copy", () => {
    expect(
      chatFeedbackMessage(
        "This preview supersedes “Synthetic Plan”. Training is unchanged until confirmation.",
      ),
    ).toEqual({
      key: "chat.planChange.feedback.superseded",
      vars: { title: "Synthetic Plan" },
    });
    expect(chatFeedbackMessage("I want to discuss my training.")).toBeNull();
  });
});

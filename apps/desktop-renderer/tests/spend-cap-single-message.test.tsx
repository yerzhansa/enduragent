import type { CoachDecisionReadModel, SpendSummary } from "@enduragent/coach-contract";
import { render, screen } from "@testing-library/react";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { LanguageProvider } from "@enduragent/i18n/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spendCapRefusalCopy } from "../src/chat/controller-helpers";
import { INITIAL_SPEND_METER_STATE } from "../src/spend-meter/controller";
import { createSpendSettingsAdapter } from "../src/state/adapters/spend";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { CoachDecisionPanel } from "../src/ui/chat/CoachDecisionPanel";
import { Notice } from "../src/ui/chat/Notice";
import { SpendNotice } from "../src/ui/chat/SpendNotice";

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const refusalCopy = spendCapRefusalCopy({
  kind: "spend-cap-reached",
  dailyCapUsd: 0.1,
  knownSpendUsd: 0.14,
});
const bannerCopy =
  "You’ve reached today’s $0.10 spend cap. New messages wait until tomorrow, or raise the cap or switch to Warn in Settings › Spending.";

function summary(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.1,
    knownSpendUsd: 0.14,
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "reached",
    capMode: "enforce",
    cacheReadTokens: 0,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: true,
    routes: [],
    ...overrides,
  };
}

const unanswered: CoachDecisionReadModel = {
  decisionId: "decision-1",
  chatId: "desktop",
  messageId: "message-1",
  question: "Choose tomorrow’s priority.",
  status: "unanswered",
  options: [
    {
      id: "recovery",
      label: "Prioritize recovery",
      description: "Choose an easy day.",
      recommended: true,
      consequence: "Tomorrow becomes a recovery day.",
    },
    {
      id: "tempo",
      label: "Keep tempo",
      description: "Keep the planned workout.",
      recommended: false,
      consequence: "Tomorrow keeps tempo.",
    },
  ],
};

const savedPending: CoachDecisionReadModel = {
  ...unanswered,
  status: "answered",
  answer: { kind: "option", optionId: "recovery" },
  consequence: "Tomorrow becomes a recovery day.",
  continuation: { continuationId: "continuation-1", status: "pending" },
};

function publishSpend(value: SpendSummary): void {
  createSpendSettingsAdapter({
    publish: (next) => useEnduragentStore.getState().patchSettings({ spend: next }),
  }).view.render({ ...INITIAL_SPEND_METER_STATE, status: "ready", summary: value });
}

function renderEnglish(element: React.ReactElement) {
  return render(
    <LanguageProvider tag="en" locale="en-GB" phrasebook={english}>
      {element}
    </LanguageProvider>,
  );
}

function capMessages(): HTMLElement[] {
  return [
    ...screen.queryAllByText(bannerCopy),
    ...screen.queryAllByText(refusalCopy),
  ].filter((node) => node.closest("[hidden]") === null);
}

beforeEach(() => {
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: { retryDecision: vi.fn() } as unknown as ChatActions,
    activeView: "chat",
  });
});

describe("one spend cap message in Chat", () => {
  it("shows only the banner when Stop refuses a queued message", () => {
    publishSpend(summary());
    useEnduragentStore.setState({ chat: { ...EMPTY_CHAT_SURFACE, notice: refusalCopy } });

    renderEnglish(
      <>
        <SpendNotice />
        <Notice />
      </>,
    );

    expect(capMessages()).toHaveLength(1);
    expect(screen.getByText(bannerCopy)).toBeVisible();
    expect(screen.queryByText(refusalCopy)).toBeNull();
  });

  it("shows the refusal when the banner is not up yet", () => {
    publishSpend(summary({ capStatus: "below", dailyCapUsd: 1 }));
    useEnduragentStore.setState({ chat: { ...EMPTY_CHAT_SURFACE, notice: refusalCopy } });

    renderEnglish(
      <>
        <SpendNotice />
        <Notice />
      </>,
    );

    expect(capMessages()).toHaveLength(1);
    expect(screen.getByText(refusalCopy)).toBeVisible();
  });

  it("keeps a refused decision open without repeating the banner", () => {
    publishSpend(summary());
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        decision: unanswered,
        decisionPhase: "idle",
        decisionError: refusalCopy,
      },
    });

    renderEnglish(
      <>
        <SpendNotice />
        <CoachDecisionPanel onCustomOpenChange={vi.fn()} />
      </>,
    );

    expect(capMessages()).toHaveLength(1);
    expect(screen.getByText("Choose tomorrow’s priority.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Try again on a refused saved choice without repeating the banner", () => {
    publishSpend(summary());
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        decision: savedPending,
        decisionPhase: "recovering",
        decisionError: refusalCopy,
      },
    });

    renderEnglish(
      <>
        <SpendNotice />
        <CoachDecisionPanel onCustomOpenChange={vi.fn()} />
      </>,
    );

    expect(capMessages()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still shows the refusal on the Plan surface, which has no banner", () => {
    publishSpend(summary());

    renderEnglish(
      <CoachDecisionPanel
        onCustomOpenChange={vi.fn()}
        surface={{
          decision: unanswered,
          phase: "idle",
          answerLabel: null,
          error: refusalCopy,
          loadError: null,
          answer: vi.fn(),
          skip: vi.fn(),
          retry: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(refusalCopy);
  });
});

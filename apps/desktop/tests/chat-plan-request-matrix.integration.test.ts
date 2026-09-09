import { createServer } from "node:net";
import type { PlanningRequestDelivery, PlanningRequestReadModel } from "@enduragent/coach-contract";
import {
  PlanActiveProjectionDataSchema,
  PlanReadModelSchema,
  PlanningRequestDeliverySchema,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it } from "vitest";
import { buildChatOriginatedPlanResultReadModel } from "../../../packages/coach/src/planning-lifecycle.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";
import { createPlanQaFixtureScript, createPlanQaHydratedModel } from "./helpers/plan-qa-live.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "p".repeat(43);
const fixtures: RunningDesktopFixture[] = [];

type MatrixState =
  | "pending"
  | "failed"
  | "retryable"
  | "delivered"
  | "conflict"
  | "apply-failed"
  | "applied"
  | "rejected"
  | "ended";

interface MatrixExpectation {
  readonly state: MatrixState;
  readonly status: string;
  readonly summary: string;
  readonly button: string | null;
  readonly disabled: boolean | null;
}

const MATRIX_EXPECTATIONS: readonly MatrixExpectation[] = [
  {
    state: "pending",
    status: "Opening",
    summary: "The workout and your Chat context are staying together.",
    button: null,
    disabled: null,
  },
  {
    state: "failed",
    status: "Couldn’t open",
    summary: "The request could not be delivered safely.",
    button: "Try again",
    disabled: true,
  },
  {
    state: "retryable",
    status: "Couldn’t open",
    summary: "The request is saved. Trying again will not create a duplicate.",
    button: "Try again",
    disabled: false,
  },
  {
    state: "delivered",
    status: "Needs review",
    summary: "Review the structured Proposal in Plan; the active Plan is unchanged.",
    button: "Review in Plan",
    disabled: false,
  },
  {
    state: "conflict",
    status: "Date conflict",
    summary: "Review the structured Proposal in Plan; the active Plan is unchanged.",
    button: "Review in Plan",
    disabled: false,
  },
  {
    state: "apply-failed",
    status: "Save failed",
    summary: "The Proposal is preserved and the active Plan is unchanged.",
    button: "Review in Plan",
    disabled: false,
  },
  {
    state: "applied",
    status: "Added to Plan",
    summary: "Tempo 3 × 12 · Wednesday · 64 min",
    button: "Open Plan",
    disabled: false,
  },
  {
    state: "rejected",
    status: "Not added",
    summary: "The active Plan remains unchanged.",
    button: "Open Plan",
    disabled: false,
  },
  {
    state: "ended",
    status: "Not added",
    summary: "The completed Plan remains unchanged.",
    button: "Open Plan",
    disabled: false,
  },
];

const ROUTED_STATES: readonly MatrixState[] = [
  "retryable",
  "delivered",
  "conflict",
  "apply-failed",
  "applied",
  "rejected",
  "ended",
];

const TERMINAL_STATES = new Set<MatrixState>(["applied", "rejected", "ended"]);

const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "codex-agent", model: "fixture", transport: "codex-agent" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "transport_incompatible",
      source: "transport_blocked",
      checkedAt: "1998-08-22T08:00:00.000Z",
    },
  },
  draft: null,
} as const;

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function requestId(state: MatrixState): string {
  return `request-${state}`;
}

function source(state: MatrixState) {
  return {
    kind: "plan_change" as const,
    intent: `Review the ${state} request in Plan.`,
    chatId: "desktop",
    messageId: `message-${state}`,
    attachmentId: null,
  };
}

function openRequest(
  state: MatrixState,
  attention: Extract<
    PlanningRequestReadModel["attention"],
    "needs_review" | "date_conflict" | "apply_failed"
  >,
): PlanningRequestReadModel {
  return {
    requestId: requestId(state),
    kind: "plan_change",
    target: "active_plan",
    intent: source(state).intent,
    planConversationId: `plan-conversation-${state}`,
    proposalId: `proposal-${state}`,
    requestedDateKey: attention === "date_conflict" ? 19980824 : null,
    resolvedDateKey: null,
    source: { chatId: "desktop", messageId: source(state).messageId, available: true },
    lifecycle: "open",
    attention,
    revision: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
    terminalResult: null,
  };
}

function terminalRequest(
  state: Extract<MatrixState, "applied" | "rejected" | "ended">,
): PlanningRequestReadModel {
  const terminalResult =
    state === "applied"
      ? {
          kind: "applied" as const,
          resultId: "result-applied",
          completedAtMs: 300,
          title: "Added to Plan",
          detail: "Tempo 3 × 12 · Wednesday · 64 min",
          workoutRef: null,
          planRevisionId: "revision-applied",
        }
      : {
          kind: state,
          resultId: `result-${state}`,
          completedAtMs: 300,
          title: state === "rejected" ? "Proposal rejected" : "Plan ended",
          detail:
            state === "rejected"
              ? "The active Plan remains unchanged."
              : "The completed Plan remains unchanged.",
          workoutRef: null,
          planRevisionId: null,
        };
  return {
    requestId: requestId(state),
    kind: "plan_change",
    target: "active_plan",
    intent: source(state).intent,
    planConversationId: `plan-conversation-${state}`,
    proposalId: null,
    requestedDateKey: null,
    resolvedDateKey: null,
    source: { chatId: "desktop", messageId: source(state).messageId, available: true },
    lifecycle: state,
    attention: "none",
    revision: 2,
    createdAtMs: 100,
    updatedAtMs: 300,
    terminalResult,
  };
}

function delivery(
  state: MatrixState,
  index: number,
  planningRequest: PlanningRequestReadModel | null,
  options: { readonly failed?: boolean; readonly retryable?: boolean } = {},
): PlanningRequestDelivery {
  const failed = options.failed === true;
  const delivered = planningRequest !== null;
  return PlanningRequestDeliverySchema.parse({
    requestId: requestId(state),
    source: source(state),
    state: failed ? "failed" : delivered ? "delivered" : "pending",
    attemptCount: failed ? 1 : delivered ? 1 : 0,
    failureCode: failed ? "planning_unavailable" : null,
    retryable: failed ? options.retryable === true : !delivered,
    createdAtMs: index + 1,
    updatedAtMs: index + 1,
    deliveredAtMs: delivered ? index + 20 : null,
    planningRequest,
  });
}

function matrixDeliveries(): PlanningRequestDelivery[] {
  return [
    delivery("pending", 0, null),
    delivery("failed", 1, null, { failed: true }),
    delivery("retryable", 2, null, { failed: true, retryable: true }),
    delivery("delivered", 3, openRequest("delivered", "needs_review")),
    delivery("conflict", 4, openRequest("conflict", "date_conflict")),
    delivery("apply-failed", 5, openRequest("apply-failed", "apply_failed")),
    delivery("applied", 6, terminalRequest("applied")),
    delivery("rejected", 7, terminalRequest("rejected")),
    delivery("ended", 8, terminalRequest("ended")),
  ];
}

function planState(request: PlanningRequestReadModel) {
  if (request.lifecycle !== "open") {
    return buildChatOriginatedPlanResultReadModel({
      request,
      planId: "plan-qa",
      lifecycle: request.lifecycle === "ended" ? "ended" : "active",
      revision: 2,
    });
  }
  const base = createPlanQaHydratedModel("PL-S007");
  const data = PlanActiveProjectionDataSchema.parse(base.data);
  const proposal = data.proposals?.[0];
  if (proposal === undefined || request.proposalId === null) {
    throw new TypeError("open Planning request requires a fixture Proposal");
  }
  const dateConflict =
    request.attention === "date_conflict"
      ? {
          recommendedDate: "1998-08-25",
          minimumDate: "1998-08-23",
          maximumDate: "1998-09-30",
          workouts: [
            {
              workoutId: "workout-conflict",
              date: "1998-08-24",
              name: "Endurance ride",
              durationS: 3_600,
              ownership: "coach" as const,
              replaceable: true,
            },
          ],
        }
      : null;
  return PlanReadModelSchema.parse({
    ...base,
    data: {
      ...data,
      workouts: data.workouts.map((workout) =>
        workout.id === proposal.targetWorkoutId
          ? { ...workout, name: `PLAN-02 ${request.requestId.replace("request-", "")}` }
          : workout,
      ),
      proposals: [{ ...proposal, id: request.proposalId }],
      selectedProposalId: request.proposalId,
      selectedPlanningRequest: { request, dateConflict },
    },
  });
}

interface ScriptRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeScript(calls: ScriptRequest[]): DesktopFixtureScript {
  const base = createPlanQaFixtureScript("PL-S004");
  let deliveries = matrixDeliveries();
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      calls.push(request);
      if (request.method === "getChatAttachmentComposer") {
        return response(emptyAttachmentComposer);
      }
      if (request.method === "resumePlanningRequests") {
        return response({ deliveries });
      }
      if (request.method === "listPlanningRequests") {
        return response({ deliveries, planCreation: null });
      }
      if (request.method === "getPlanningRequest") {
        const found = deliveries.find((item) => item.requestId === request.params.requestId);
        return response(
          found === undefined ? { status: "missing" } : { status: "found", delivery: found },
        );
      }
      if (request.method === "retryPlanningRequest") {
        const index = deliveries.findIndex((item) => item.requestId === request.params.requestId);
        const current = deliveries[index];
        if (current === undefined || current.state !== "failed" || !current.retryable) {
          return response({ status: "missing" });
        }
        const restored = delivery("retryable", 2, openRequest("retryable", "needs_review"));
        deliveries = deliveries.map((item, itemIndex) => (itemIndex === index ? restored : item));
        return response({ status: "found", delivery: restored });
      }
      if (request.method === "executePlanTransition" && request.params.transitionId === "PL-T36") {
        const found = deliveries.find((item) => item.requestId === request.params.requestId);
        if (found?.state !== "delivered" || found.planningRequest === null) {
          throw new TypeError("Planning request is not routable");
        }
        return response({ status: "completed", state: planState(found.planningRequest) });
      }
      return base.onRequest(value);
    },
  };
}

async function launch(input: {
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
}): Promise<{ readonly fixture: RunningDesktopFixture; readonly calls: ScriptRequest[] }> {
  const calls: ScriptRequest[] = [];
  const fixture = await launchDesktopFixture({
    script: makeScript(calls),
    token,
    width: input.width,
    height: input.height,
    colorScheme: input.colorScheme,
    reducedMotion: true,
    hidden: process.env.PLAN_02_VISIBLE === "1" ? false : true,
  });
  fixtures.push(fixture);
  await fixture.evaluate<void>(`
    await document.fonts.ready;
    const deadline = Date.now() + 10000;
    while (
      (document.documentElement.dataset.rpc !== "connected" ||
        document.querySelectorAll("[data-planning-request-id]").length !== 9) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  `);
  return { fixture, calls };
}

async function openPlanFromCard(
  fixture: RunningDesktopFixture,
  state: MatrixState,
): Promise<{
  readonly destinationReady: boolean;
  readonly scenario: string | null;
  readonly scrollTop: number;
  readonly bodyText: string;
  readonly currentNavigation: string | null;
}> {
  return fixture.evaluate(`
    const card = document.querySelector('[data-planning-request-id="${requestId(state)}"]');
    if (!(card instanceof HTMLElement)) throw new Error("Planning request card missing");
    card.scrollIntoView({ block: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrollTop = document.querySelector(".conversation").scrollTop;
    const button = card.querySelector("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error("Planning request action unavailable");
    }
    button.click();
    const deadline = Date.now() + 5000;
    const targetState = ${JSON.stringify(state)};
    const destinationReady = () => {
      const bodyText = document.body.innerText.replace(/\\s+/g, " ").trim();
      const scenario =
        document.querySelector("[data-plan-scenario]")?.getAttribute("data-plan-scenario") ?? null;
      if (targetState === "conflict") return bodyText.includes("DATE CONFLICT");
      if (targetState === "applied") {
        return scenario === "PL-S099" && bodyText.includes("Added to Plan");
      }
      if (targetState === "rejected") {
        return scenario === "PL-S099" && bodyText.includes("Proposal rejected");
      }
      if (targetState === "ended") {
        return scenario === "PL-S099" && bodyText.includes("Plan ended");
      }
      return scenario === "PL-S007" && bodyText.includes("PLAN-02 " + targetState);
    };
    while (!destinationReady() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      destinationReady: destinationReady(),
      scenario: document.querySelector("[data-plan-scenario]")?.getAttribute("data-plan-scenario") ?? null,
      scrollTop,
      bodyText: document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 800),
      currentNavigation:
        document.querySelector('nav[aria-label="Main navigation"] [aria-current="page"]')
          ?.textContent?.trim() ?? null,
    };
  `);
}

async function returnThroughSidebar(fixture: RunningDesktopFixture): Promise<void> {
  await fixture.evaluate<void>(`
    const navigation = document.querySelector('nav[aria-label="Main navigation"]');
    const button = [...navigation.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Chat");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Chat navigation missing");
    button.click();
    const deadline = Date.now() + 5000;
    while (document.querySelector(".chat-surface") === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  `);
}

async function returnToExactCard(
  fixture: RunningDesktopFixture,
  state: MatrixState,
  scrollTop: number,
): Promise<void> {
  const result = await fixture.evaluate<{
    readonly focusedRequestId: string | null;
    readonly scrollDelta: number;
  }>(`
    const button = [...document.querySelectorAll(".plan-view button")].find(
      (item) => item.textContent?.trim() === "Back to Chat",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Back to Chat missing");
    button.click();
    const deadline = Date.now() + 5000;
    const requestId = ${JSON.stringify(requestId(state))};
    while (
      (document.querySelector(".chat-surface") === null ||
        document.activeElement?.getAttribute("data-planning-request-id") !== requestId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      focusedRequestId: document.activeElement?.getAttribute("data-planning-request-id") ?? null,
      scrollDelta: Math.abs(document.querySelector(".conversation").scrollTop - ${scrollTop}),
    };
  `);
  expect(result).toEqual({ focusedRequestId: requestId(state), scrollDelta: expect.any(Number) });
  expect(result.scrollDelta).toBeLessThanOrEqual(64);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("Chat Plan request matrix", () => {
  it.each([
    { label: "wide Light", width: 1180, height: 820, colorScheme: "light" as const },
    { label: "wide Dark", width: 1180, height: 820, colorScheme: "dark" as const },
    { label: "compact Light", width: 760, height: 820, colorScheme: "light" as const },
    { label: "compact Dark", width: 760, height: 820, colorScheme: "dark" as const },
  ])(
    "renders and routes every request state in $label",
    async (configuration) => {
      const { fixture, calls } = await launch(configuration);
      const snapshot = await fixture.evaluate<{
        readonly cards: readonly {
          readonly state: string;
          readonly status: string;
          readonly summary: string;
          readonly button: string | null;
          readonly disabled: boolean | null;
          readonly readOnly: boolean;
          readonly withinColumn: boolean;
        }[];
        readonly documentOverflow: boolean;
        readonly theme: string | null;
      }>(`
      const ids = ${JSON.stringify(MATRIX_EXPECTATIONS.map((entry) => entry.state))};
      const conversation = document.querySelector(".conversation");
      const conversationRect = conversation.getBoundingClientRect();
      return {
        cards: ids.map((state) => {
          const card = document.querySelector('[data-planning-request-id="request-' + state + '"]');
          const cardRect = card.getBoundingClientRect();
          const status = card.querySelector(":scope > div:first-child > span");
          const summary = card.querySelector(":scope > p");
          const button = card.querySelector("button");
          return {
            state,
            status: status?.textContent?.trim() ?? "",
            summary: summary?.textContent?.trim() ?? "",
            button: button?.textContent?.trim() ?? null,
            disabled: button instanceof HTMLButtonElement ? button.disabled : null,
            readOnly: card.querySelector('input, textarea, select, [contenteditable="true"]') === null,
            withinColumn:
              cardRect.left >= conversationRect.left && cardRect.right <= conversationRect.right,
          };
        }),
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        theme: document.documentElement.dataset.theme ?? null,
      };
    `);
      expect(snapshot).toEqual({
        cards: MATRIX_EXPECTATIONS.map((entry) => ({
          ...entry,
          readOnly: true,
          withinColumn: true,
        })),
        documentOverflow: false,
        theme: configuration.colorScheme,
      });

      for (const state of ROUTED_STATES) {
        const opened = await openPlanFromCard(fixture, state);
        expect(
          opened.destinationReady,
          JSON.stringify({ state, opened, calls: calls.slice(-10) }, null, 2),
        ).toBe(true);
        expect(opened.currentNavigation).toBe("Plan");
        if (TERMINAL_STATES.has(state)) {
          await returnToExactCard(fixture, state, opened.scrollTop);
        } else {
          await returnThroughSidebar(fixture);
        }
      }

      expect(
        calls
          .filter((call) => call.method === "retryPlanningRequest")
          .map((call) => ({ method: call.method, params: call.params })),
      ).toEqual([
        {
          method: "retryPlanningRequest",
          params: { requestId: requestId("retryable") },
        },
      ]);
      expect(
        calls
          .filter(
            (call) =>
              call.method === "executePlanTransition" && call.params.transitionId === "PL-T36",
          )
          .map((call) => call.params.requestId),
      ).toEqual(ROUTED_STATES.map(requestId));
    },
    120_000,
  );
});

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlanActiveProjectionDataSchema,
  PlanReadModelSchema,
  type CreatePlanningRequestPayload,
  type PlanningRequestOperations,
  type PlanningRequestReadModel,
} from "@enduragent/coach-contract";
import {
  createPlanningRequestRepository,
  type PlanningRequestRepository,
} from "@enduragent/kernel/planning";
import {
  createChatPlanOutboxRepository,
  runMigrations,
  type ChatPlanOutboxRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanningRequestDeliveryService } from "../../../packages/coach/src/planning-request-delivery.js";
import { createPlanningRequestSourceCleanup } from "../../../packages/coach/src/planning-request-source-cleanup.js";
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

const token = "r".repeat(43);
const archiveBoundaryRef = "b".repeat(64);
const beforeTransportId = "request-before-transport";
const afterAcceptanceId = "request-after-acceptance";
const beforeDeletionId = "request-before-deletion";
const fixtures: RunningDesktopFixture[] = [];
const backends: PlanningRelaunchBackend[] = [];
const scratchPaths: string[] = [];

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

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function payload(requestId: string): CreatePlanningRequestPayload {
  return {
    requestId,
    kind: "plan_change",
    intent: `PLAN-03 ${requestId}`,
    source: {
      chatId: "desktop",
      messageId: `message-${requestId}`,
    },
    sourceSnapshot: {
      capturedAt: "1998-08-24T08:00:00.000Z",
      attachment: null,
      selectedWorkout: null,
    },
    requestedDate: "1998-08-26",
  };
}

function openPlanState(request: PlanningRequestReadModel) {
  const base = createPlanQaHydratedModel("PL-S004");
  const data = PlanActiveProjectionDataSchema.parse(base.data);
  return PlanReadModelSchema.parse({
    ...base,
    data: {
      ...data,
      selectedPlanningRequest: { request, dateConflict: null },
    },
  });
}

class PlanningRelaunchBackend {
  readonly calls: ScriptRequest[] = [];
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private outbox: ChatPlanOutboxRepository | undefined;
  private requests: PlanningRequestRepository | undefined;
  private operations: PlanningRequestOperations | undefined;
  private instant = 100;
  private interruptAfterAcceptance = false;
  private resumeUnavailable = false;
  private archiveDeleted = false;

  constructor(private readonly databasePath: string) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "resumePlanningRequests") {
          if (this.resumeUnavailable) throw new Error("synthetic resume interruption");
          return response(await this.requireOperations().resumePlanningRequests?.({}));
        }
        if (request.method === "listPlanningRequests") {
          return response(
            await this.requireOperations().listPlanningRequests?.({ chatId: "desktop" }),
          );
        }
        if (request.method === "getPlanningRequest") {
          return response(
            await this.requireOperations().getPlanningRequest?.({
              requestId: String(request.params.requestId),
            }),
          );
        }
        if (request.method === "retryPlanningRequest") {
          return response(
            await this.requireOperations().retryPlanningRequest?.({
              requestId: String(request.params.requestId),
            }),
          );
        }
        if (request.method === "getPlanState" && this.archiveDeleted) {
          const record = await this.requireRequests().read(afterAcceptanceId);
          if (record === undefined) throw new TypeError("delivered Planning request is missing");
          return response({
            status: "ready",
            state: buildChatOriginatedPlanResultReadModel({
              request: record.request,
              planId: "plan-qa",
              lifecycle: "active",
              revision: record.request.revision,
            }),
          });
        }
        if (
          request.method === "executePlanTransition" &&
          request.params.transitionId === "PL-T36"
        ) {
          const result = await this.requireOperations().getPlanningRequest?.({
            requestId: String(request.params.requestId),
          });
          if (result?.status !== "found" || result.delivery.planningRequest === null) {
            throw new TypeError("Planning request is not routable");
          }
          const planningRequest = result.delivery.planningRequest;
          const state =
            planningRequest.lifecycle === "open"
              ? openPlanState(planningRequest)
              : buildChatOriginatedPlanResultReadModel({
                  request: planningRequest,
                  planId: "plan-qa",
                  lifecycle: planningRequest.lifecycle === "ended" ? "ended" : "active",
                  revision: planningRequest.revision,
                });
          return response({ status: "completed", state });
        }
        if (request.method === "listArchivedConversations") {
          return response({
            schemaVersion: 1,
            conversations: this.archiveDeleted
              ? []
              : [
                  {
                    boundaryRef: archiveBoundaryRef,
                    boundaryAt: "1998-08-25T08:00:00.000Z",
                    reason: "explicit-reset",
                    turnCount: 3,
                  },
                ],
            truncated: false,
          });
        }
        if (request.method === "getArchivedTranscriptPage") {
          return response({
            schemaVersion: 1,
            status: this.archiveDeleted ? "restart-required" : "page",
            turns: this.archiveDeleted
              ? []
              : [
                  {
                    turnId: `message-${afterAcceptanceId}`,
                    completedAt: "1998-08-25T07:00:00.000Z",
                    athleteText: "Please update my Plan.",
                    coachText: "I kept the request linked to this conversation.",
                  },
                ],
            nextCursor: null,
          });
        }
        if (request.method === "deleteArchivedConversation") {
          if (this.archiveDeleted) {
            return response({ schemaVersion: 1, status: "not-found" });
          }
          await createPlanningRequestSourceCleanup({
            outbox: this.requireOutbox(),
            requests: this.requireRequests(),
            identity: this.identity(),
          })("desktop", {
            messageIds: [beforeTransportId, afterAcceptanceId, beforeDeletionId].map(
              (requestId) => `message-${requestId}`,
            ),
            attachmentIds: [],
          });
          this.archiveDeleted = true;
          return response({ schemaVersion: 1, status: "deleted" });
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    const store = openSqliteStorage(this.databasePath);
    await runMigrations(store, MIGRATIONS);
    this.store = store;
    const crypto = createNodeCrypto();
    this.outbox = createChatPlanOutboxRepository(store, crypto);
    this.requests = createPlanningRequestRepository(store, crypto);
    this.operations = createPlanningRequestDeliveryService(
      {
        outbox: this.outbox,
        requests: this.requests,
        identity: this.identity(),
        readPlanCreationCard: async () => null,
        resolveTarget: async () => "active_plan",
      },
      {
        afterPlanningAccepted: async () => {
          if (this.interruptAfterAcceptance) {
            throw new Error("synthetic interruption after Planning acceptance");
          }
        },
      },
    );
  }

  async reopen(): Promise<void> {
    await this.closeStore();
    await this.open();
  }

  async close(): Promise<void> {
    await this.closeStore();
  }

  async seedPending(requestId: string): Promise<void> {
    await this.requireOutbox().createOrGet({
      payload: payload(requestId),
      createdAtMs: this.stamp().physicalMs,
    });
  }

  async seedAcceptedFailure(requestId: string): Promise<void> {
    this.interruptAfterAcceptance = true;
    const result = await this.requireOperations().createPlanningRequest?.({
      payload: payload(requestId),
    });
    this.interruptAfterAcceptance = false;
    if (result?.status !== "accepted" || result.delivery.state !== "failed") {
      throw new TypeError("accepted-before-ack fixture did not fail after Planning acceptance");
    }
  }

  setResumeUnavailable(value: boolean): void {
    this.resumeUnavailable = value;
  }

  async complete(requestId: string): Promise<void> {
    const record = await this.requireRequests().read(requestId);
    if (record === undefined) throw new TypeError("Planning request is missing");
    const stamp = this.stamp();
    await this.requireRequests().complete({
      requestId,
      expectedRevision: record.request.revision,
      result: {
        kind: "applied",
        resultId: `result-${requestId}`,
        completedAtMs: stamp.physicalMs,
        title: "Added to Plan",
        detail: "Tempo 3 × 12 · Wednesday · 64 min",
        workoutRef: null,
        planRevisionId: `revision-${requestId}`,
      },
      resolvedDateKey: 19980826,
      updatedAtMs: stamp.physicalMs,
      deviceId: "device-plan-03",
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  }

  async snapshot() {
    const outbox = this.requireOutbox();
    const requests = this.requireRequests();
    const [beforeTransport, afterAcceptance, beforeDeletion] = await Promise.all([
      outbox.read(beforeTransportId),
      outbox.read(afterAcceptanceId),
      outbox.read(beforeDeletionId),
    ]);
    const [beforeTransportRequest, afterAcceptanceRequest] = await Promise.all([
      requests.read(beforeTransportId),
      requests.read(afterAcceptanceId),
    ]);
    return {
      beforeTransport,
      afterAcceptance,
      beforeDeletion,
      beforeTransportRequest,
      afterAcceptanceRequest,
      openRequestCount: (await requests.readOpen()).length,
    };
  }

  private identity(): AuthoredIdentity {
    return {
      deviceId: async () => "device-plan-03",
      newUlid: () => "01J60HFQ7T0000000000000001",
      hlcStamp: () => this.stamp(),
    };
  }

  private stamp(): { readonly physicalMs: number; readonly counter: number } {
    return { physicalMs: this.instant++, counter: 0 };
  }

  private requireOutbox(): ChatPlanOutboxRepository {
    if (this.outbox === undefined) throw new TypeError("Planning outbox is closed");
    return this.outbox;
  }

  private requireRequests(): PlanningRequestRepository {
    if (this.requests === undefined) throw new TypeError("Planning requests are closed");
    return this.requests;
  }

  private requireOperations(): PlanningRequestOperations {
    if (this.operations === undefined) throw new TypeError("Planning operations are closed");
    return this.operations;
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.outbox = undefined;
    this.requests = undefined;
    this.operations = undefined;
    if (store !== undefined) await store.close();
  }
}

async function waitForCard(
  fixture: RunningDesktopFixture,
  requestId: string,
  buttonLabel: string,
): Promise<{ readonly status: string; readonly button: string; readonly cardCount: number }> {
  return fixture.evaluate(`
    const requestId = ${JSON.stringify(requestId)};
    const buttonLabel = ${JSON.stringify(buttonLabel)};
    const deadline = Date.now() + 10000;
    let card = document.querySelector('[data-planning-request-id="' + requestId + '"]');
    while (
      (card === null || card.querySelector("button")?.textContent?.trim() !== buttonLabel) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      card = document.querySelector('[data-planning-request-id="' + requestId + '"]');
    }
    if (!(card instanceof HTMLElement)) throw new Error("Planning request card missing");
    return {
      status: card.querySelector(":scope > div:first-child > span")?.textContent?.trim() ?? "",
      button: card.querySelector("button")?.textContent?.trim() ?? "",
      cardCount: document.querySelectorAll('[data-planning-request-id="' + requestId + '"]').length,
    };
  `);
}

async function returnToChat(fixture: RunningDesktopFixture): Promise<void> {
  await fixture.evaluate<void>(`
    const navigation = document.querySelector('nav[aria-label="Main navigation"]');
    const button = [...navigation.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "Chat",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Chat navigation missing");
    button.click();
    const deadline = Date.now() + 5000;
    while (document.querySelector(".chat-surface") === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  `);
}

async function deleteArchivedConversation(fixture: RunningDesktopFixture): Promise<void> {
  await fixture.evaluate<void>(`
    const navigation = document.querySelector('nav[aria-label="Main navigation"]');
    const pastChats = [...navigation.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Past chats"),
    );
    if (!(pastChats instanceof HTMLButtonElement)) throw new Error("Past chats navigation missing");
    pastChats.click();
    const deadline = Date.now() + 5000;
    let entry = document.querySelector("button.archive-entry");
    while (entry === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      entry = document.querySelector("button.archive-entry");
    }
    if (!(entry instanceof HTMLButtonElement)) throw new Error("Archived conversation missing");
    entry.click();
    let trigger = document.querySelector("button.archive-delete");
    while (trigger === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      trigger = document.querySelector("button.archive-delete");
    }
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("Delete action missing");
    trigger.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const confirm = [...document.querySelectorAll(".archive-delete-dialog button")].find(
      (button) => button.textContent?.trim() === "Delete conversation",
    );
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("Delete confirmation missing");
    confirm.click();
    while (
      (document.querySelector(".archive-delete-dialog") !== null ||
        document.querySelector("button.archive-entry") !== null) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  `);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat Plan request relaunch and source deletion",
  () => {
    it("recovers every durable handoff stage and removes invalid source return", async () => {
      const scratch = await mkdtemp(join(tmpdir(), "plan-03-"));
      scratchPaths.push(scratch);
      const backend = new PlanningRelaunchBackend(join(scratch, "planning.sqlite"));
      backends.push(backend);
      await backend.open();
      await backend.seedPending(beforeTransportId);

      const fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: process.env.PLAN_03_VISIBLE === "1" ? false : true,
      });
      fixtures.push(fixture);

      expect(await waitForCard(fixture, beforeTransportId, "Continue in Plan")).toEqual({
        status: "Continue in Plan",
        button: "Continue in Plan",
        cardCount: 1,
      });
      expect(await backend.snapshot()).toMatchObject({
        beforeTransport: { state: "delivered", attemptCount: 1 },
        beforeTransportRequest: {
          request: { requestId: beforeTransportId, revision: 1, lifecycle: "open" },
        },
      });

      await backend.seedAcceptedFailure(afterAcceptanceId);
      backend.setResumeUnavailable(true);
      await fixture.relaunch(() => backend.reopen());
      expect(await waitForCard(fixture, afterAcceptanceId, "Try again")).toEqual({
        status: "Couldn’t open",
        button: "Try again",
        cardCount: 1,
      });

      backend.setResumeUnavailable(false);
      await fixture.evaluate<void>(`
        const card = document.querySelector('[data-planning-request-id="${afterAcceptanceId}"]');
        const button = card?.querySelector("button");
        if (!(button instanceof HTMLButtonElement)) throw new Error("Retry action missing");
        button.click();
        const deadline = Date.now() + 5000;
        while (
          !document.body.innerText.includes("PLAN-03 ${afterAcceptanceId}") &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      `);
      expect(
        backend.calls
          .filter((call) => call.method === "retryPlanningRequest")
          .map((call) => call.params),
      ).toEqual([{ requestId: afterAcceptanceId }]);
      expect(await backend.snapshot()).toMatchObject({
        afterAcceptance: { state: "delivered", attemptCount: 2 },
        afterAcceptanceRequest: {
          request: { requestId: afterAcceptanceId, revision: 1, lifecycle: "open" },
        },
        openRequestCount: 2,
      });

      await returnToChat(fixture);
      await fixture.relaunch(() => backend.reopen());
      expect(await waitForCard(fixture, afterAcceptanceId, "Continue in Plan")).toEqual({
        status: "Continue in Plan",
        button: "Continue in Plan",
        cardCount: 1,
      });

      await backend.complete(afterAcceptanceId);
      await fixture.relaunch(() => backend.reopen());
      expect(await waitForCard(fixture, afterAcceptanceId, "Open Plan")).toEqual({
        status: "Added to Plan",
        button: "Open Plan",
        cardCount: 1,
      });

      await backend.seedPending(beforeDeletionId);
      await deleteArchivedConversation(fixture);
      expect(await backend.snapshot()).toMatchObject({
        beforeTransport: { state: "delivered", payload: null },
        afterAcceptance: { state: "delivered", payload: null },
        beforeDeletion: {
          state: "cancelled",
          payload: null,
          cancelReason: "source_conversation_deleted",
        },
        beforeTransportRequest: {
          request: { lifecycle: "open", source: { available: false } },
          sourceState: { status: "detached_open" },
        },
        afterAcceptanceRequest: {
          request: { lifecycle: "applied", source: { available: false } },
          sourceState: { status: "compacted" },
          tombstone: { status: "applied" },
        },
        openRequestCount: 1,
      });

      await fixture.relaunch(() => backend.reopen());
      expect(
        await fixture.evaluate<{
          readonly scenario: string | null;
          readonly hasBackToChat: boolean;
          readonly hasTerminalTruth: boolean;
          readonly sourceCardCount: number;
        }>(`
          const deadline = Date.now() + 10000;
          let navigation = document.querySelector('nav[aria-label="Main navigation"]');
          while (navigation === null && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            navigation = document.querySelector('nav[aria-label="Main navigation"]');
          }
          if (!(navigation instanceof HTMLElement)) throw new Error("Main navigation missing");
          const sourceCardCount = document.querySelectorAll(
            '[data-planning-request-id="${afterAcceptanceId}"]',
          ).length;
          const plan = [...navigation.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Plan",
          );
          if (!(plan instanceof HTMLButtonElement)) throw new Error("Plan navigation missing");
          plan.click();
          const planDeadline = Date.now() + 5000;
          while (
            document.querySelector('[data-plan-scenario="PL-S099"]') === null &&
            Date.now() < planDeadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const result = document.querySelector('[data-plan-scenario="PL-S099"]');
          return {
            scenario: result?.getAttribute("data-plan-scenario") ?? null,
            hasBackToChat: [...(result?.querySelectorAll("button") ?? [])].some(
              (action) => action.textContent?.trim() === "Back to Chat",
            ),
            hasTerminalTruth:
              result?.textContent?.includes("Added to Plan") === true &&
              result.textContent.includes("Tempo 3 × 12 · Wednesday · 64 min"),
            sourceCardCount,
          };
        `),
      ).toEqual({
        scenario: "PL-S099",
        hasBackToChat: false,
        hasTerminalTruth: true,
        sourceCardCount: 0,
      });

      const finalSnapshot = await backend.snapshot();
      expect(finalSnapshot).toMatchObject({
        beforeTransport: { state: "delivered", attemptCount: 1 },
        afterAcceptance: { state: "delivered", attemptCount: 2 },
        beforeDeletion: { state: "cancelled" },
        afterAcceptanceRequest: {
          request: { requestId: afterAcceptanceId, lifecycle: "applied" },
          tombstone: { status: "applied" },
        },
      });
      expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      fixtures.splice(fixtures.indexOf(fixture), 1);
    }, 120_000);
  },
);

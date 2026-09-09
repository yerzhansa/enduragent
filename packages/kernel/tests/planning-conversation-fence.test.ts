import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";
import { runMigrations } from "../src/store/migrator.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import {
  createLegacyPlanTransitionRepository,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
  type PlanSourceRequestRecord,
} from "../src/planning/conversation-repository.js";
import { createPlanRepository } from "../src/planning/repository.js";
import {
  createLegacyWriterFence,
  LegacyPlanningAuthorityError,
} from "../src/planning/writer-fence.js";

const id = (value: number) => String(value).padStart(26, "0");
const stamp = { deviceId: "synthetic-device", hlcPhysicalMs: 100, hlcCounter: 0 };
const conversation: PlanConversationRecord = {
  id: id(1),
  planId: id(2),
  replacesPlanId: null,
  courseChoiceStatus: "omitted",
  raceCourseJson: null,
  status: "open",
  endedAtMs: null,
  createdAtMs: 100,
  updatedAtMs: 100,
  ...stamp,
};
const draft: PlanDraftRevisionRecord = {
  id: id(3),
  conversationId: conversation.id,
  planId: id(2),
  revision: 1,
  parentRevisionId: null,
  status: "ready",
  snapshotJson: "{}",
  raceCourseJson: null,
  createdAtMs: 100,
  updatedAtMs: 100,
  ...stamp,
};
const source: PlanSourceRequestRecord = {
  id: id(4),
  conversationId: conversation.id,
  sourceChatId: "synthetic-chat",
  sourceBoundaryRef: null,
  sourceMessageId: "synthetic-message",
  requestJson: "{}",
  createdAtMs: 100,
  updatedAtMs: 100,
  ...stamp,
};

async function fixture() {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  await createPlanRepository(store).replace(
    {
      id: id(2),
      originId: null,
      name: "Synthetic Plan",
      primaryGoal: "Improve fitness",
      startDateKey: 19980901,
      targetDateKey: 19981123,
      status: "draft",
      kind: "full_plan",
      totalWeeks: 12,
      weekStartDay: 2,
      structureJson: "{}",
      createdAtMs: 100,
      updatedAtMs: 100,
      ...stamp,
    },
    [],
  );
  const repository = createLegacyPlanTransitionRepository(store);
  await repository.saveConversation(conversation);
  await repository.saveDraftRevision(draft);
  await repository.createOrGetSourceRequest(source);
  return { store, repository };
}

describe("legacy conversation writer fence", () => {
  it.each([
    "saveConversation",
    "appendTurn",
    "saveDraftRevision",
    "approveDraft",
    "createOrGetSourceRequest",
    "bindSourceBoundary",
  ] as const)("checks Chat authority inside %s before any write", async (mutation) => {
    const { store, repository } = await fixture();
    expect(await createLegacyWriterFence(store).fenced()).toBe(false);
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
      await store.run(
        "UPDATE planning_authority SET chat_authority_since_ms = 101 WHERE singleton = 1",
      );
      return transaction(operation);
    });
    const run = vi.spyOn(store, "run");
    const mutations = {
      saveConversation: () => repository.saveConversation({ ...conversation, updatedAtMs: 101 }),
      appendTurn: () =>
        repository.appendTurn({
          id: id(5),
          conversationId: conversation.id,
          sequence: 1,
          athleteText: "Continue this Plan",
          coachText: "Training details",
          lineageJson: "{}",
          completedAtMs: 100,
          ...stamp,
        }),
      saveDraftRevision: () => repository.saveDraftRevision({ ...draft, status: "discarded" }),
      approveDraft: () =>
        repository.approveDraft({
          draftRevisionId: draft.id,
          expectedRevision: 1,
          updatedAtMs: 101,
          ...stamp,
        }),
      createOrGetSourceRequest: () => repository.createOrGetSourceRequest({ ...source, id: id(6) }),
      bindSourceBoundary: () =>
        repository.bindSourceBoundary({ ...source, sourceBoundaryRef: "boundary" }),
    };
    await expect(mutations[mutation]()).rejects.toBeInstanceOf(LegacyPlanningAuthorityError);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "UPDATE planning_authority SET chat_authority_since_ms = 101 WHERE singleton = 1",
    );
    expect(await repository.readConversation(conversation.id)).toEqual(conversation);
    expect(await repository.readDraftRevision(draft.id)).toEqual(draft);
    expect(await repository.readSourceRequests(conversation.id)).toEqual([source]);
    expect(await repository.readTurns(conversation.id)).toEqual([]);
    expect(await store.get("SELECT status FROM plan WHERE id = ?", [id(2)])).toEqual({
      status: "draft",
    });
  });
});

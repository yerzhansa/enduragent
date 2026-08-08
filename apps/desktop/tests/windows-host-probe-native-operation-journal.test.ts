import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROBE_NATIVE_OPERATION_INTENT_KIND,
  PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
  createProbeNativeOperationIntent,
  deriveProbeNativeOperationIntentSha256,
  openProbeNativeOperationJournal,
  validateProbeNativeOperationIntent,
  type ProbeNativeOperationIntent,
  type ProbeNativeOperationIntentDraft,
  type ProbeNativeOperationJournal,
  type ProbeNativeOperationRecoveryClass,
} from "../scripts/windows-host-falsifier/probe-native-operation-journal.mjs";
import {
  createProbeNativeActionPlan,
  deriveProbeNativeActionPlanStepOperationId,
} from "../scripts/windows-host-falsifier/probe-native-action-plan.mjs";
import { PROBE_CAMPAIGN_ID } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { getProbeRunWorkItem } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operationIntent(
  operationId = "operation-one",
  recoveryClass: ProbeNativeOperationRecoveryClass = "read-only-replay",
  overrides: Partial<ProbeNativeOperationIntentDraft> = {},
): ProbeNativeOperationIntent {
  const draft: ProbeNativeOperationIntentDraft = {
    schemaVersion: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
    kind: PROBE_NATIVE_OPERATION_INTENT_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    operationId,
    actionPlanSha256: digest("action plan"),
    stepId: "capture-home",
    command: "home-identity",
    inputSha256: digest("native input"),
    recoveryClass,
    ...overrides,
  };
  return {
    ...draft,
    intentSha256: deriveProbeNativeOperationIntentSha256(draft),
  };
}

function actionPlan() {
  const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
  return createProbeNativeActionPlan({
    candidateSha256: digest("candidate"),
    campaignRunId: "campaign-run",
    executionRunId: "execution-run",
    attemptId: "attempt-one",
    workId: getProbeRunWorkItem({
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
    }).workId,
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    rowId: "F-01",
    variantId: "f01-ordinary-absolute-path",
    scenarioPlanSha256: definition.planSha256,
    producerActionId: "prepare-home-topology",
    consumerActionId: "capture-home-identity",
    operationId: "operation-one",
    evidenceRootObjectIdentitySha256: digest("evidence root"),
    steps: [
      {
        sequence: 1,
        stepId: "observe.home",
        command: "home-identity",
        request: { relativePath: "targets/home" },
        timeoutMs: 30_000,
        recoveryClass: "read-only-replay",
      },
    ],
    prerequisiteEvidence: [],
  });
}

const databaseLeaf = "native-operation-journal.sqlite";
const executionLeaseDatabaseLeaf = "native-operation-execution-lease.sqlite";
const metadataNoDeleteTriggerSql = [
  "CREATE TRIGGER native_operation_metadata_no_delete",
  "BEFORE DELETE ON native_operation_metadata",
  "BEGIN",
  "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
  "END",
].join("\n");

function removeJournalMetadata(database: DatabaseSync) {
  database.exec("DROP TRIGGER native_operation_metadata_no_delete");
  database.exec("DELETE FROM native_operation_metadata");
  database.exec(metadataNoDeleteTriggerSql);
}

describe("Windows host probe guest-native operation journal", () => {
  let root: string;
  let journals: ProbeNativeOperationJournal[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "enduragent-native-journal-")));
    journals = [];
  });

  afterEach(async () => {
    for (const journal of journals) await journal.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  async function openJournal(
    path = root,
    limits?: Parameters<typeof openProbeNativeOperationJournal>[0]["limits"],
  ) {
    const journal = await openProbeNativeOperationJournal({ root: path, limits });
    journals.push(journal);
    return journal;
  }

  it("transactionally initializes a precreated empty database", async () => {
    const databasePath = join(root, databaseLeaf);
    await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });

    const journal = await openJournal();
    await expect(journal.scan()).resolves.toMatchObject({
      operations: [],
      incompleteOperationIds: [],
    });
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT singleton, schema_version, kind, campaign_id FROM native_operation_metadata",
        )
        .all(),
    ).toEqual([
      {
        singleton: 1,
        schema_version: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
        kind: "windows-host-probe-native-operation-journal",
        campaign_id: PROBE_CAMPAIGN_ID,
      },
    ]);
    database.close();
  });

  it("recovers only the exact empty legacy schema prefix missing its metadata row", async () => {
    let journal = await openJournal();
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    let database = new DatabaseSync(databasePath);
    removeJournalMetadata(database);
    database.close();

    journal = await openJournal();
    await expect(journal.scan()).resolves.toMatchObject({ operations: [] });
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    database = new DatabaseSync(databasePath);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM native_operation_metadata").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("completes an exact empty legacy initialization prefix atomically", async () => {
    let journal = await openJournal();
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    let database = new DatabaseSync(databasePath);
    removeJournalMetadata(database);
    database.exec("DROP TRIGGER native_operation_transitions_no_update");
    database.close();

    journal = await openJournal();
    await expect(journal.scan()).resolves.toMatchObject({ operations: [] });
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'native_operation_transitions_no_update'",
        )
        .all(),
    ).toEqual([{ name: "native_operation_transitions_no_update" }]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM native_operation_metadata").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("does not repair metadata-less schema that already contains operation evidence", async () => {
    const journal = await openJournal();
    const intent = operationIntent("retained-before-initialization-corruption");
    await journal.claimOperation(intent);
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    let database = new DatabaseSync(databasePath);
    removeJournalMetadata(database);
    database.close();

    await expect(openProbeNativeOperationJournal({ root })).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
    });

    database = new DatabaseSync(databasePath);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM native_operation_metadata").get(),
    ).toEqual({ count: 0 });
    expect(database.prepare("SELECT operation_id FROM native_operations").all()).toEqual([
      { operation_id: intent.operationId },
    ]);
    database.close();
  });

  it("does not overwrite a precreated database with an unknown schema", async () => {
    const databasePath = join(root, databaseLeaf);
    await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE unknown_owner_state (value TEXT NOT NULL) STRICT");
    database.close();

    await expect(openProbeNativeOperationJournal({ root })).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
    });

    database = new DatabaseSync(databasePath);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([{ name: "unknown_owner_state" }]);
    database.close();
  });

  it("validates an exact canonical action-plan-bound intent", () => {
    const value = operationIntent();
    expect(validateProbeNativeOperationIntent(value)).toEqual(value);

    expect(() =>
      validateProbeNativeOperationIntent({ ...value, inputSha256: digest("changed") }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_OPERATION_JOURNAL_INTENT_DIGEST" }));
    expect(() =>
      validateProbeNativeOperationIntent({ ...value, token: "not-allowed" }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_OPERATION_JOURNAL_SCHEMA" }));
    expect(() =>
      operationIntent("operation-one", "read-only-replay", {
        command: "not-a-native-command" as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_OPERATION_JOURNAL_COMMAND" }));
    expect(() => operationIntent("operation-one", "automatic-replay" as never)).toThrowError(
      expect.objectContaining({ code: "NATIVE_OPERATION_JOURNAL_RECOVERY_CLASS" }),
    );
  });

  it("derives its immutable key and recovery authority from the validated action plan", () => {
    const plan = actionPlan();
    const value = createProbeNativeOperationIntent({
      actionPlan: plan,
      stepId: "observe.home",
      inputSha256: digest("native input frame"),
    });

    expect(value).toMatchObject({
      operationId: deriveProbeNativeActionPlanStepOperationId(plan, "observe.home"),
      actionPlanSha256: plan.actionPlanSha256,
      stepId: "observe.home",
      command: "home-identity",
      recoveryClass: "read-only-replay",
    });
    expect(validateProbeNativeOperationIntent(value)).toEqual(value);
    expect(() =>
      createProbeNativeOperationIntent({
        actionPlan: plan,
        stepId: "missing-step",
        inputSha256: digest("native input frame"),
      }),
    ).toThrowError(expect.objectContaining({ code: "NATIVE_OPERATION_JOURNAL_ACTION_PLAN" }));
  });

  it("atomically grants one journal handle ownership of a dense execution batch", async () => {
    const first = await openJournal();
    const second = await openJournal();
    const intents = [
      operationIntent("mutation-one", "never-auto-replay"),
      operationIntent("mutation-two", "inspect-and-reconcile", {
        stepId: "mutate-two",
        inputSha256: digest("native input two"),
      }),
    ];

    const acquisitions = await Promise.all([
      first.acquireExecutionBatch(intents),
      second.acquireExecutionBatch(intents),
    ]);
    expect(acquisitions.map((entry) => entry.acquired).sort()).toEqual([false, true]);

    const owner = acquisitions.find((entry) => entry.acquired);
    if (owner === undefined || !owner.acquired) throw new Error("execution owner was not selected");
    expect(owner.records.map((record) => record.operationId)).toEqual([
      "mutation-one",
      "mutation-two",
    ]);
    expect(owner.records.map((record) => record.currentState)).toEqual(["claim", "claim"]);
    expect(owner.records.map((record) => record.transitions)).toEqual([
      [expect.objectContaining({ sequence: 1, state: "claim" })],
      [expect.objectContaining({ sequence: 1, state: "claim" })],
    ]);

    const observer = acquisitions.find((entry) => !entry.acquired);
    if (observer === undefined || observer.acquired) {
      throw new Error("non-owner recovery was not returned");
    }
    expect(observer.recoveries).toEqual([
      expect.objectContaining({
        operationId: "mutation-one",
        currentState: "claim",
        decision: "INCONCLUSIVE",
      }),
      expect.objectContaining({
        operationId: "mutation-two",
        currentState: "claim",
        decision: "INCONCLUSIVE",
      }),
    ]);

    await expect(first.scan()).resolves.toMatchObject({
      operations: [
        { operationId: "mutation-one", currentState: "claim", transitions: [{ state: "claim" }] },
        { operationId: "mutation-two", currentState: "claim", transitions: [{ state: "claim" }] },
      ],
    });
  });

  it("holds a cross-process execution lease without blocking journal transitions", async () => {
    const owner = await openJournal();
    const observer = await openJournal();
    const lease = await owner.tryAcquireExecutionLease();
    expect(lease).toMatchObject({ acquired: true });
    expect(Object.isFrozen(lease)).toBe(true);
    if (!lease.acquired) throw new Error("execution lease was not acquired");

    await expect(observer.tryAcquireExecutionLease()).resolves.toEqual({ acquired: false });
    await expect(owner.claimOperation(operationIntent("leased-operation"))).resolves.toMatchObject({
      created: true,
      record: { currentState: "claim" },
    });

    await lease.release();
    await lease.release();
    const transferred = await observer.tryAcquireExecutionLease();
    expect(transferred).toMatchObject({ acquired: true });
    if (!transferred.acquired) throw new Error("execution lease did not transfer");
    await transferred.release();
  });

  it("releases the cross-process execution lease when its owner process terminates", async () => {
    const moduleUrl = new URL(
      "../scripts/windows-host-falsifier/probe-native-operation-journal.mjs",
      import.meta.url,
    ).href;
    const childSource = [
      `import { openProbeNativeOperationJournal } from ${JSON.stringify(moduleUrl)};`,
      `const journal = await openProbeNativeOperationJournal({ root: ${JSON.stringify(root)} });`,
      "const lease = await journal.tryAcquireExecutionLease();",
      "if (!lease.acquired) throw new Error('child did not acquire execution lease');",
      "process.stdout.write('LEASED\\n');",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "--eval", childSource],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let childError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childError += chunk;
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("LEASED\n")) resolveReady();
        });
        child.once("exit", (code) => {
          rejectReady(new Error(`lease child exited ${String(code)}: ${childError}`));
        });
        child.once("error", rejectReady);
      });

      const observer = await openJournal();
      await expect(observer.tryAcquireExecutionLease()).resolves.toEqual({ acquired: false });
      child.kill("SIGKILL");
      await once(child, "exit");

      const recovered = await observer.tryAcquireExecutionLease();
      expect(recovered).toMatchObject({ acquired: true });
      if (!recovered.acquired) throw new Error("terminated owner lease remained held");
      await recovered.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    }
  }, 15_000);

  it("fails closed without overwriting a changed execution lease database", async () => {
    let journal = await openJournal();
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    const leaseDatabasePath = join(root, executionLeaseDatabaseLeaf);
    let database = new DatabaseSync(leaseDatabasePath);
    database.exec("CREATE TABLE unknown_lease_state (value TEXT NOT NULL) STRICT");
    database.close();

    journal = await openJournal();
    await expect(journal.tryAcquireExecutionLease()).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_LEASE_SCHEMA",
    });
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    database = new DatabaseSync(leaseDatabasePath);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "unknown_lease_state" },
    ]);
    database.close();
  });

  it("returns retained-transcript recovery without transferring execution ownership", async () => {
    const owner = await openJournal();
    const observer = await openJournal();
    const intent = operationIntent("retained-mutation", "never-auto-replay");
    const transcriptSha256 = digest("retained mutation transcript");
    const acquisition = await owner.acquireExecutionBatch([intent]);
    expect(acquisition).toMatchObject({ acquired: true });
    await owner.recordEffectStarted({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
    });
    const retained = await owner.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: transcriptSha256,
    });

    const recovery = await observer.acquireExecutionBatch([intent]);
    expect(recovery).toMatchObject({
      acquired: false,
      recoveries: [
        {
          operationId: intent.operationId,
          currentState: "transcript-retained",
          decision: "RESUME_RETAINED_TRANSCRIPT",
          transcriptSha256,
          retainedTranscript: {
            transcriptSha256,
            transitionRecordSha256: retained.record.transitions.at(-1)?.recordSha256,
          },
        },
      ],
    });
    await expect(observer.readOperation(intent.operationId)).resolves.toMatchObject({
      currentState: "transcript-retained",
      transitions: [
        { state: "claim" },
        { state: "effect-started" },
        { state: "transcript-retained" },
      ],
    });
  });

  it("fails closed on partial or changed batch reuse without claiming absent operations", async () => {
    const owner = await openJournal();
    const observer = await openJournal();
    const claimed = operationIntent("claimed-mutation", "never-auto-replay");
    const absent = operationIntent("absent-mutation", "never-auto-replay", {
      stepId: "absent-step",
      inputSha256: digest("absent native input"),
    });
    await owner.acquireExecutionBatch([claimed]);

    await expect(observer.acquireExecutionBatch([claimed, absent])).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_BATCH_PARTIAL",
    });
    await expect(owner.readOperation(absent.operationId)).resolves.toBeNull();

    const changed = operationIntent(claimed.operationId, claimed.recoveryClass, {
      inputSha256: digest("changed native input"),
    });
    await expect(observer.acquireExecutionBatch([absent, changed])).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
    });
    await expect(owner.readOperation(absent.operationId)).resolves.toBeNull();
    await expect(owner.readOperation(claimed.operationId)).resolves.toMatchObject({
      intent: claimed,
      currentState: "claim",
      transitions: [{ state: "claim" }],
    });
  });

  it("rejects empty, sparse, and duplicate execution batches", async () => {
    const journal = await openJournal();
    const intent = operationIntent();
    const sparse = Array<ProbeNativeOperationIntent>(2);
    sparse[1] = operationIntent("operation-two");

    for (const batch of [[], sparse, [intent, intent]]) {
      await expect(journal.acquireExecutionBatch(batch)).rejects.toMatchObject({
        code: "NATIVE_OPERATION_JOURNAL_BATCH",
      });
    }
    await expect(journal.scan()).resolves.toMatchObject({ operations: [] });
  });

  it("retains the strict monotonic chain before returning a durable terminal result", async () => {
    const journal = await openJournal();
    const intent = operationIntent();
    const transcriptSha256 = digest("native transcript");
    const resultSha256 = digest("canonical action result");

    await expect(journal.decideRecovery(intent)).resolves.toMatchObject({
      currentState: null,
      decision: "CLAIM_BEFORE_EXECUTION",
      retainedTranscript: null,
      terminalResultSha256: null,
    });

    const claim = await journal.claimOperation(intent);
    expect(claim).toMatchObject({
      created: true,
      record: { currentState: "claim" },
      recovery: { decision: "EXECUTE" },
    });
    expect(claim.record.transitions).toHaveLength(1);
    await expect(journal.decideRecovery(intent)).resolves.toMatchObject({
      currentState: "claim",
      decision: "INCONCLUSIVE",
      reason: "claim-owner-is-unknown",
    });
    await expect(journal.claimOperation(intent)).resolves.toMatchObject({
      created: false,
      recovery: { decision: "INCONCLUSIVE", reason: "claim-owner-is-unknown" },
    });

    await expect(
      journal.recordEffectStarted({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
      }),
    ).resolves.toMatchObject({
      created: true,
      record: { currentState: "effect-started" },
    });
    await expect(journal.decideRecovery(intent)).resolves.toMatchObject({
      decision: "REPLAY_READ_ONLY",
      currentState: "effect-started",
      retainedTranscript: null,
    });

    const retained = await journal.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: transcriptSha256,
    });
    expect(retained).toMatchObject({
      created: true,
      record: {
        currentState: "transcript-retained",
        transcriptSha256,
      },
    });
    const transcriptTransition = retained.record.transitions.at(-1);
    expect(transcriptTransition?.state).toBe("transcript-retained");
    await expect(journal.decideRecovery(intent)).resolves.toMatchObject({
      decision: "RESUME_RETAINED_TRANSCRIPT",
      reason: "retained-transcript-awaits-terminal-publication",
      currentState: "transcript-retained",
      transcriptSha256,
      retainedTranscript: {
        transcriptSha256,
        transitionRecordSha256: transcriptTransition?.recordSha256,
      },
      terminalResultSha256: null,
    });
    await expect(
      journal.recordTerminalResultRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: resultSha256,
      }),
    ).resolves.toMatchObject({
      created: true,
      record: {
        currentState: "terminal-result-retained",
        terminalResultSha256: resultSha256,
      },
    });

    const recovery = await journal.decideRecovery(intent);
    expect(recovery).toMatchObject({
      decision: "RETURN_RETAINED_RESULT",
      currentState: "terminal-result-retained",
      transcriptSha256,
      retainedTranscript: {
        transcriptSha256,
        transitionRecordSha256: transcriptTransition?.recordSha256,
      },
      terminalResultSha256: resultSha256,
    });
    expect(recovery.decisionSha256).toMatch(/^[a-f0-9]{64}$/u);

    const record = await journal.readOperation(intent.operationId);
    expect(record?.transitions.map((entry) => entry.state)).toEqual([
      "claim",
      "effect-started",
      "transcript-retained",
      "terminal-result-retained",
    ]);
    expect(record?.transitions.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(record?.transitions[0]?.previousRecordSha256).toBeNull();
    expect(record?.transitions[1]?.previousRecordSha256).toBe(record?.transitions[0]?.recordSha256);
    expect(record?.transitions[2]?.previousRecordSha256).toBe(record?.transitions[1]?.recordSha256);
    expect(record?.transitions[3]?.previousRecordSha256).toBe(record?.transitions[2]?.recordSha256);

    await expect(journal.scan()).resolves.toMatchObject({
      journalMode: "wal",
      synchronous: "FULL",
      incompleteOperationIds: [],
    });
  });

  it("resumes retained transcripts after restart before consulting recovery class", async () => {
    let journal = await openJournal();
    const readOnly = operationIntent("read-only-operation", "read-only-replay");
    const reconcile = operationIntent("reconcile-operation", "inspect-and-reconcile");
    const noReplay = operationIntent("no-replay-operation", "never-auto-replay");
    const retainedIntents = [
      operationIntent("retained-read-only-operation", "read-only-replay"),
      operationIntent("retained-reconcile-operation", "inspect-and-reconcile"),
      operationIntent("retained-no-replay-operation", "never-auto-replay"),
    ];

    for (const intent of [readOnly, reconcile, noReplay, ...retainedIntents]) {
      await journal.claimOperation(intent);
      await journal.recordEffectStarted({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
      });
    }
    const retainedReferences = new Map<
      string,
      { transcriptSha256: string; transitionRecordSha256: string }
    >();
    for (const intent of retainedIntents) {
      const transcriptSha256 = digest(`retained transcript for ${intent.operationId}`);
      const result = await journal.recordTranscriptRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: transcriptSha256,
      });
      retainedReferences.set(intent.operationId, {
        transcriptSha256,
        transitionRecordSha256: result.record.transitions.at(-1)!.recordSha256,
      });
    }

    await journal.close();
    journals = journals.filter((entry) => entry !== journal);
    journal = await openJournal();

    await expect(journal.decideRecovery(readOnly)).resolves.toMatchObject({
      decision: "REPLAY_READ_ONLY",
      currentState: "effect-started",
    });
    await expect(journal.decideRecovery(reconcile)).resolves.toMatchObject({
      decision: "INSPECT_AND_RECONCILE",
      currentState: "effect-started",
      retainedTranscript: null,
    });
    await expect(journal.decideRecovery(noReplay)).resolves.toMatchObject({
      decision: "INCONCLUSIVE",
      currentState: "effect-started",
      retainedTranscript: null,
    });
    for (const intent of retainedIntents) {
      const retainedTranscript = retainedReferences.get(intent.operationId)!;
      await expect(journal.decideRecovery(intent)).resolves.toMatchObject({
        decision: "RESUME_RETAINED_TRANSCRIPT",
        reason: "retained-transcript-awaits-terminal-publication",
        currentState: "transcript-retained",
        transcriptSha256: retainedTranscript.transcriptSha256,
        retainedTranscript,
        terminalResultSha256: null,
      });
    }
    await expect(journal.scan()).resolves.toMatchObject({
      incompleteOperationIds: [
        "no-replay-operation",
        "read-only-operation",
        "reconcile-operation",
        "retained-no-replay-operation",
        "retained-read-only-operation",
        "retained-reconcile-operation",
      ],
    });
  });

  it("rejects a corrupted retained transcript reference before recovery", async () => {
    const journal = await openJournal();
    const intent = operationIntent();
    await journal.claimOperation(intent);
    await journal.recordEffectStarted({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
    });
    await journal.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: digest("retained transcript"),
    });
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    const database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER native_operation_transitions_no_update");
    database
      .prepare(
        "UPDATE native_operation_transitions SET artifact_sha256 = ? WHERE operation_id = ? AND state = 'transcript-retained'",
      )
      .run(digest("substituted transcript"), intent.operationId);
    database.exec(
      [
        "CREATE TRIGGER native_operation_transitions_no_update",
        "BEFORE UPDATE ON native_operation_transitions",
        "BEGIN",
        "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
        "END",
      ].join("\n"),
    );
    database.close();

    await expect(openProbeNativeOperationJournal({ root })).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_RECORD",
    });
  });

  it("fails closed on changed operation reuse and changed transition artifacts", async () => {
    const journal = await openJournal();
    const intent = operationIntent();
    await journal.claimOperation(intent);

    const changedInput = operationIntent("operation-one", "read-only-replay", {
      inputSha256: digest("different input"),
    });
    await expect(journal.claimOperation(changedInput)).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
    });
    await expect(journal.decideRecovery(changedInput)).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
    });
    await expect(
      journal.recordEffectStarted({
        operationId: intent.operationId,
        intentSha256: digest("another intent"),
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
    });

    await journal.recordEffectStarted({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
    });
    const transcriptSha256 = digest("transcript one");
    await journal.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: transcriptSha256,
    });
    await expect(
      journal.recordTranscriptRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: transcriptSha256,
      }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      journal.recordTranscriptRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: digest("transcript two"),
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_TRANSITION_CONFLICT",
    });
  });

  it("rejects skipped transitions and refuses any transition before a claim", async () => {
    const journal = await openJournal();
    const intent = operationIntent();

    await expect(
      journal.recordEffectStarted({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_OPERATION_JOURNAL_UNCLAIMED" });

    await journal.claimOperation(intent);
    await expect(
      journal.recordTranscriptRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: digest("transcript"),
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_TRANSITION_ORDER",
    });

    await journal.recordEffectStarted({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
    });
    await expect(
      journal.recordTerminalResultRetained({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
        artifactSha256: digest("result"),
      }),
    ).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_TRANSITION_ORDER",
    });
  });

  it("enforces append-only database triggers and rejects a changed schema", async () => {
    const journal = await openJournal();
    const intent = operationIntent();
    await journal.claimOperation(intent);
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    let database = new DatabaseSync(databasePath);
    expect(() =>
      database
        .prepare("UPDATE native_operations SET input_sha256 = ? WHERE operation_id = ?")
        .run(digest("corrupt"), intent.operationId),
    ).toThrow();
    expect(() =>
      database
        .prepare("DELETE FROM native_operation_transitions WHERE operation_id = ?")
        .run(intent.operationId),
    ).toThrow();
    database.close();

    const reopened = await openJournal();
    await expect(reopened.readOperation(intent.operationId)).resolves.toMatchObject({
      currentState: "claim",
      intent,
    });
    await reopened.close();
    journals = journals.filter((entry) => entry !== reopened);

    database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER native_operations_no_update");
    database.close();

    await expect(openProbeNativeOperationJournal({ root })).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
    });
  });

  it("fails closed when its database identity or private root contents change", async () => {
    const journal = await openJournal();
    await writeFile(join(root, "unexpected.txt"), "unexpected", { mode: 0o600 });
    await expect(journal.scan()).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_ROOT_CONTENT",
    });
  });

  it("rejects hard-linked database state and enforces the operation bound", async () => {
    let journal = await openJournal(root, { maxOperations: 1 });
    await journal.claimOperation(operationIntent());
    await expect(journal.claimOperation(operationIntent("operation-two"))).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_LIMIT",
    });
    const databasePath = journal.databasePath;
    await journal.close();
    journals = journals.filter((entry) => entry !== journal);

    await link(databasePath, join(root, "journal-copy.sqlite"));
    await expect(openProbeNativeOperationJournal({ root })).rejects.toMatchObject({
      code: "NATIVE_OPERATION_JOURNAL_HARD_LINK",
    });
  });
});

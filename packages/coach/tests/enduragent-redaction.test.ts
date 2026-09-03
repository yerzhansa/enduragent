import { createServer as createNetServer } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CoachRemoteError, type CoachVerbTransport } from "@enduragent/coach-cli";
import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  JsonRpcErrorResponseEnvelopeSchema,
  type AthleteState,
  type CoachEngine,
} from "@enduragent/coach-contract";
import { resolveAthleteHome } from "@enduragent/kernel-node/home";
import { runEnduragent, type EnduragentDependencies } from "../src/enduragent.js";
import type { WithLocalCoachInput } from "../src/local-runner.js";
import { withCoachStoreWriter } from "../src/runtime.js";
import type { SpendMeterService } from "../src/spend-meter.js";
import { planCreationOperationStubs } from "./helpers/plan-creation-operation-stubs.js";

const API_KEY_SECRET = "F8_LOCAL_API_KEY_MUST_NOT_ESCAPE";
const MESSAGE_SECRET = "F8_LOCAL_MESSAGE_MUST_NOT_ESCAPE";
const STACK_SECRET = "F8_LOCAL_STACK_MUST_NOT_ESCAPE";
const URL_SECRET = "F8_LOCAL_URL_MUST_NOT_ESCAPE";
const PROVIDER_SECRET = "F8_LOCAL_PROVIDER_MUST_NOT_ESCAPE";
const ARBITRARY_SECRET = "F8_LOCAL_ARBITRARY_MUST_NOT_ESCAPE";
const NON_ERROR_SECRET = "F8_LOCAL_NON_ERROR_MUST_NOT_ESCAPE";
const NESTED_SECRET = "F8_LOCAL_NESTED_AUTH_MUST_NOT_ESCAPE";
const roots: string[] = [];

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2000-01-01T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2000-01-01T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const spendMeter: SpendMeterService = {
  getSpendSummary: async () => {
    throw new Error("unused spend meter");
  },
  setDailySpendCap: async () => {
    throw new Error("unused spend meter");
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(): { readonly stream: Writable; read(): string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    }),
    read: () => value,
  };
}

function fabricatedError(): Error {
  const error = Object.assign(new Error(`synthetic failure ${MESSAGE_SECRET}`), {
    apiKey: API_KEY_SECRET,
    statusCode: 503,
    nested: { authorization: `Bearer ${NESTED_SECRET}` },
    url: `https://example.invalid/${URL_SECRET}`,
    provider: PROVIDER_SECRET,
    diagnosticNote: ARBITRARY_SECRET,
  });
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: `Error: synthetic failure ${STACK_SECRET}`,
  });
  return error;
}

function hostileError(): Error {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("F8_LOCAL_HOSTILE_PROXY_MUST_NOT_ESCAPE");
      },
    },
  );
  return Object.assign(new Error("synthetic hostile failure"), { statusCode: hostile });
}

function engine(readFailure: () => unknown): CoachEngine {
  return {
    chat: async () => {
      throw readFailure();
    },
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => {
      throw readFailure();
    },
    skipCoachDecision: async () => {
      throw readFailure();
    },
    resumeCoachDecision: async () => {
      throw readFailure();
    },
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM enduragent-redaction\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

describe.skipIf(!hasLoopback)("local CLI redaction boundary", () => {
  it("renders local engine failures only through redacted terminal envelopes", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "enduragent-redaction-"));
    roots.push(root);
    const env = {
      ENDURAGENT_HOME: root,
      CYCLING_COACH_HOME: root,
    };
    const home = resolveAthleteHome(env);
    let failure: unknown = fabricatedError();
    const coachEngine = engine(() => failure);
    const withLocalCoach: EnduragentDependencies["withLocalCoach"] = async <T>(
      input: WithLocalCoachInput<T>,
    ) => {
      const value = await withCoachStoreWriter(env, async (context) =>
        input.operation({
          home: context.home,
          engine: coachEngine,
          operations: {
            ...planCreationOperationStubs,
            importFiles: async ({ paths }) => ({
              schemaVersion: 2,
              files: { total: paths.length, imported: paths.length, quarantined: 0 },
              changes: {
                rawFilesInserted: 0,
                sourceRecordsInserted: 0,
                sourceRecordsUpdated: 0,
                relinkedSourceRecords: 0,
              },
              publication: { scope: "activities-and-streams", status: "available" },
            }),
            sync: async () => ({
              schemaVersion: 1,
              published: false,
              referenceSucceeded: true,
              requests: { store: 0, reference: 0, total: 0 },
              droppedActivities: {
                overall: { total: 0, visible: 0, restrictions: [], other: 0 },
                recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
              },
            }),
            saveIntake: async () => ({ schemaVersion: 1, saved: true }),
            getTranscriptPage: async () => ({
              schemaVersion: 1,
              status: "page",
              turns: [],
              nextCursor: null,
            }),
            listArchivedConversations: async () => ({
              schemaVersion: 1,
              conversations: [],
              truncated: false,
            }),
            deleteArchivedConversation: async () => ({ schemaVersion: 1, status: "deleted" }),
            getArchivedTranscriptPage: async () => ({
              schemaVersion: 1,
              status: "page",
              turns: [],
              nextCursor: null,
            }),
            configureRuntime: async ({ llm, intervals, session }) => ({
              schemaVersion: 3,
              status: "applied",
              applied: {
                llm: llm !== undefined,
                intervals: intervals !== undefined,
                session: session !== undefined,
              },
            }),
            getRuntimeConfig: async () => ({
              schemaVersion: 3,
              llm: {
                provider: "anthropic",
                model: "synthetic-model",
                credential_configured: false,
              },
              intervals: {
                athlete_id: "synthetic-athlete",
                credential_configured: false,
                managedByEnvironment: { athleteId: false },
              },
              session: {
                historyTokenBudgetRatio: 0.3,
                idleMinutes: 0,
                dailyResetHour: 4,
                resetArchiveRetentionDays: 0,
                timezone: "UTC",
                managedByEnvironment: {
                  historyTokenBudgetRatio: false,
                  idleMinutes: false,
                  dailyResetHour: false,
                  resetArchiveRetentionDays: false,
                  timezone: false,
                },
              },
            }),
          },
          spendMeter,
          confirmations: {
            peek: () => undefined,
            confirm: async () => ({ status: "none" }),
            cancel: () => "none",
          },
          listener: context.listener,
          startInitialRefresh: async () => {},
          close: async () => {},
        }),
      );
      return { status: "completed", value };
    };
    const dependencies: EnduragentDependencies = {
      resolveAthleteHome: () => home,
      withLocalCoach,
      readPackageVersion: async () => "synthetic",
    };

    for (const outputMode of ["--stream-json", "--json", undefined] as const) {
      failure = fabricatedError();
      const stdout = capture();
      const stderr = capture();
      const result = await runEnduragent(
        {
          argv: [
            "ask",
            "synthetic request",
            "--local",
            "--session",
            "synthetic",
            ...(outputMode === undefined ? [] : [outputMode]),
          ],
          env,
          terminal: {
            input: new PassThrough(),
            stdout: stdout.stream,
            stderr: stderr.stream,
            isTTY: false,
          },
          signal: new AbortController().signal,
        },
        dependencies,
      );
      expect(result).toBe(EXIT_AGENT_ERROR);
      expect(stderr.read()).toBe("Enduragent could not complete this command.\n");
      if (outputMode === "--stream-json") {
        const lines = stdout.read().trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        const line = lines[0];
        if (line === undefined) throw new TypeError("missing local terminal line");
        const envelope = JsonRpcErrorResponseEnvelopeSchema.parse(JSON.parse(line));
        expect(envelope).toEqual({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Internal error",
            data: {
              name: "Error",
              statusCode: 503,
              apiKey: "[redacted]",
              nested: { authorization: "[redacted]" },
              diagnosticNote: "[redacted]",
            },
          },
        });
      } else {
        expect(stdout.read()).toBe("");
      }
      const emitted = `${stdout.read()}${stderr.read()}`;
      for (const secret of [
        API_KEY_SECRET,
        MESSAGE_SECRET,
        STACK_SECRET,
        URL_SECRET,
        PROVIDER_SECRET,
        ARBITRARY_SECRET,
        NESTED_SECRET,
      ]) {
        expect(emitted).not.toContain(secret);
      }
      await expect(withCoachStoreWriter(env, async () => undefined)).resolves.toBeUndefined();
    }

    for (const variant of [
      { failure: NON_ERROR_SECRET, data: { name: "NonError" } },
      { failure: hostileError(), data: { name: "UnserializableError" } },
    ]) {
      failure = variant.failure;
      const stdout = capture();
      const stderr = capture();
      await expect(
        runEnduragent(
          {
            argv: ["ask", "synthetic request", "--local", "--stream-json"],
            env,
            terminal: {
              input: new PassThrough(),
              stdout: stdout.stream,
              stderr: stderr.stream,
              isTTY: false,
            },
            signal: new AbortController().signal,
          },
          dependencies,
        ),
      ).resolves.toBe(EXIT_AGENT_ERROR);
      const envelope = JsonRpcErrorResponseEnvelopeSchema.parse(JSON.parse(stdout.read().trim()));
      expect(envelope.error.data).toEqual(variant.data);
      expect(`${stdout.read()}${stderr.read()}`).not.toContain(String(variant.failure));
    }
  });

  it("keeps transport classifications fixed without fabricating terminals", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "enduragent-transport-redaction-"));
    roots.push(root);
    const env = { ENDURAGENT_HOME: root, CYCLING_COACH_HOME: root };
    const home = resolveAthleteHome(env);
    const rows = [
      {
        failure: Object.assign(new CoachRemoteError({ kind: "agent" }), {
          apiKey: API_KEY_SECRET,
          diagnosticNote: ARBITRARY_SECRET,
        }),
        exit: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not complete this command.\n",
      },
      {
        failure: Object.assign(new CoachRemoteError({ kind: "unavailable" }), {
          apiKey: API_KEY_SECRET,
          diagnosticNote: ARBITRARY_SECRET,
        }),
        exit: EXIT_DAEMON_UNAVAILABLE,
        stderr: "Enduragent could not reach the local service.\n",
      },
    ];
    for (const row of rows) {
      for (const outputMode of ["--stream-json", "--json", undefined] as const) {
        const stdout = capture();
        const stderr = capture();
        const transport: CoachVerbTransport = {
          kind: "remote",
          request: async () => {
            throw row.failure;
          },
          close: async () => {},
        };
        const result = await runEnduragent(
          {
            argv: ["ask", "synthetic request", ...(outputMode === undefined ? [] : [outputMode])],
            env,
            terminal: {
              input: new PassThrough(),
              stdout: stdout.stream,
              stderr: stderr.stream,
              isTTY: false,
            },
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            withLocalCoach: async () => {
              throw new Error("local runner must not be used");
            },
            readPackageVersion: async () => "synthetic",
            connectRemoteTransport: async () => transport,
          },
        );
        expect(result).toBe(row.exit);
        expect(stdout.read()).toBe("");
        expect(stderr.read()).toBe(row.stderr);
        expect(`${stdout.read()}${stderr.read()}`).not.toContain(API_KEY_SECRET);
        expect(`${stdout.read()}${stderr.read()}`).not.toContain(ARBITRARY_SECRET);
      }
    }
  });
});

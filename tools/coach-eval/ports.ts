import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, asSchema, jsonSchema, type Tool, type ToolSet } from "ai";
import { IntervalsClient } from "intervals-icu-api";
import type {
  AthleteDataReaderPort,
  EngineHostPorts,
  MemoryStorePort,
  ModelTransportDecorator,
  PlatformCalendarMutationsPort,
  ToolConfirmationPort,
  UsageLedgerLine,
} from "@enduragent/engine";
import type { Config } from "../../packages/core/src/config.js";
import { contextWindowForModel } from "../../packages/core/src/config.js";
import { createEngineHostAdapter } from "../../packages/core/src/agent/engine-host-adapter.js";
import { bundledAcceptedCatalog } from "../../packages/core/src/model-catalog.js";
import { legacyStateReader } from "../../packages/core/src/agent/legacy-athlete-state-reader.js";
import { createNpmCoachLanguage } from "../../packages/core/src/language-preference.js";
import { createStoreAthleteDataReader } from "../../packages/core/src/athlete-data.js";
import {
  ConfirmationGate,
  createProposalSummarizers,
  createToolConfirmationPort,
} from "../../packages/core/src/agent/confirmation-gate.js";
import { UNPARSED_TOOL, type ExecutedWrite, type Proposal, type ToolAttempt, type TurnObservation } from "./checks.js";
import type { StoreFixture } from "./fixture.js";
import type { SpendMeter } from "./spend.js";

export type Channel = "desktop" | "telegram";

export const CHAT_IDS: Readonly<Record<Channel, string>> = {
  desktop: "desktop",
  telegram: "4242",
};

const RECORDED_MEMORY_WRITES: ReadonlySet<string> = new Set([
  "writeSection",
  "renameSection",
  "renameSections",
  "appendDailyNote",
  "appendEvent",
  "savePlan",
]);

export class CaseRecorder {
  readonly attempts: ToolAttempt[] = [];
  readonly proposals: Proposal[] = [];
  readonly writes: ExecutedWrite[] = [];
  readonly usage: UsageLedgerLine[] = [];
  private offered = new Set<string>();
  private mark = { attempts: 0, proposals: 0, writes: 0 };

  offer(names: readonly string[]): void {
    for (const name of names) this.offered.add(name);
  }

  startTurn(): void {
    this.offered = new Set();
    this.mark = {
      attempts: this.attempts.length,
      proposals: this.proposals.length,
      writes: this.writes.length,
    };
  }

  finishTurn(reply: string, pendingProposal: boolean): TurnObservation {
    return {
      reply,
      offeredTools: Array.from(this.offered),
      attempts: this.attempts.slice(this.mark.attempts),
      proposals: this.proposals.slice(this.mark.proposals),
      pendingProposal,
      writes: this.writes.slice(this.mark.writes),
    };
  }
}

const KEY_REJECTED_STATUS: ReadonlySet<number> = new Set([401, 402, 403]);

function keyRejection(error: unknown): string | undefined {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return undefined;
  if (!KEY_REJECTED_STATUS.has(error.statusCode)) return undefined;
  return `the model provider refused the key in OPENROUTER_API_KEY (HTTP ${error.statusCode}: ${error.message})`;
}

const TOOL_NAME_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

interface CallLog {
  readonly caller: string;
  validated: number;
  toolStarts: number;
  readonly unknownNames: Set<string>;
}

function recordAttempts(name: string, tool: Tool, recorder: CaseRecorder, log: CallLog): Tool {
  const schema = asSchema(tool.inputSchema);
  return {
    ...tool,
    inputSchema: jsonSchema(() => schema.jsonSchema, {
      validate: async (value: unknown) => {
        const result =
          schema.validate === undefined
            ? { success: true as const, value }
            : await schema.validate(value);
        log.validated++;
        recorder.attempts.push({ tool: name, input: value, valid: result.success, caller: log.caller });
        return result;
      },
    }),
  };
}

function watchUnknownNames(tools: ToolSet, log: CallLog): ToolSet {
  return new Proxy(tools, {
    get(target, property, receiver) {
      if (typeof property === "string" && !Object.hasOwn(target, property) && TOOL_NAME_SHAPE.test(property)) {
        log.unknownNames.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function recordUnseenCalls(recorder: CaseRecorder, log: CallLog): void {
  for (const name of log.unknownNames) {
    recorder.attempts.push({ tool: name, input: undefined, valid: false, caller: log.caller });
  }
  const unparsed = log.toolStarts - log.validated - log.unknownNames.size;
  for (let index = 0; index < unparsed; index++) {
    recorder.attempts.push({ tool: UNPARSED_TOOL, input: undefined, valid: false, caller: log.caller });
  }
}

export function recordingDecorator(
  recorder: CaseRecorder,
  meter: SpendMeter,
): ModelTransportDecorator {
  return (next) => ({
    generate: async (request) => {
      meter.assertCanCall();
      const { tools, onStreamActivity } = request.options;
      const log: CallLog = {
        caller: request.options.caller ?? "unknown",
        validated: 0,
        toolStarts: 0,
        unknownNames: new Set(),
      };
      if (tools !== undefined) recorder.offer(Object.keys(tools));
      const recordedTools: ToolSet | undefined =
        tools === undefined
          ? undefined
          : watchUnknownNames(
              Object.fromEntries(
                Object.entries(tools).map(([name, tool]) => [name, recordAttempts(name, tool, recorder, log)]),
              ),
              log,
            );
      try {
        return await next.generate({
          ...request,
          options: {
            ...request.options,
            tools: recordedTools,
            onStreamActivity: (activity) => {
              if (activity.type === "tool_start") log.toolStarts++;
              onStreamActivity?.(activity);
            },
          },
        });
      } catch (error) {
        const rejection = keyRejection(error);
        if (rejection !== undefined) meter.halt(rejection);
        meter.recordFailedCall();
        throw error;
      } finally {
        recordUnseenCalls(recorder, log);
      }
    },
  });
}

export function createFixtureReader(fixture: StoreFixture | "failing"): AthleteDataReaderPort {
  return fixture === "failing"
    ? createStoreAthleteDataReader({ snapshot: () => undefined })
    : createStoreAthleteDataReader({
        snapshot: () => fixture.snapshot,
        canonicalActivities: fixture.activities,
      });
}

export function recordingCalendar(recorder: CaseRecorder): PlatformCalendarMutationsPort {
  let nextEventId = 7_001;
  const write = (operation: string, input: unknown): void => {
    recorder.writes.push({ target: "calendar", operation, input });
  };
  return {
    createEvent: async (input) => {
      write("createEvent", input);
      return { id: nextEventId++, ...input };
    },
    readEventForDelete: async ({ eventId }) => {
      throw new Error(`The eval calendar holds no event ${eventId}.`);
    },
    updateEvent: async (input) => {
      write("updateEvent", input);
      return { id: input.eventId, ...input.patch };
    },
    deleteEvent: async (input) => {
      write("deleteEvent", input);
      return { id: input.eventId };
    },
  };
}

function recordingMemory(memory: MemoryStorePort, recorder: CaseRecorder): MemoryStorePort {
  return new Proxy(memory, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property === "string" && RECORDED_MEMORY_WRITES.has(property)) {
        return (...args: unknown[]) => {
          recorder.writes.push({ target: "memory", operation: property, input: args });
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  });
}

async function refuseNetwork(): Promise<Response> {
  throw new Error("The coach eval has no intervals.icu connection.");
}

function confirmationPort(
  gate: ConfirmationGate,
  recorder: CaseRecorder,
  language: ReturnType<typeof createNpmCoachLanguage>,
): ToolConfirmationPort {
  const port = createToolConfirmationPort({
    gate,
    language,
    summarizers: createProposalSummarizers({
      intervals: new IntervalsClient({ apiKey: "coach-eval", athleteId: "0", fetch: refuseNetwork }),
      tz: "UTC",
    }),
    requiresConfirmation: ({ chatId }) =>
      chatId !== "desktop" && chatId !== "cli" && !chatId.startsWith("cli:"),
  });
  return {
    ...port,
    propose: async (input) => {
      recorder.proposals.push({ tool: input.toolName, input: input.toolInput });
      return port.propose(input);
    },
  };
}

export interface EvalPortsInput {
  readonly model: string;
  readonly apiKey: string;
  readonly fixture: StoreFixture | "failing" | undefined;
  readonly recorder: CaseRecorder;
  readonly meter: SpendMeter;
}

export interface EvalPorts {
  readonly ports: EngineHostPorts;
  readonly gate: ConfirmationGate;
  readonly dispose: () => void;
}

export function createEvalPorts(input: EvalPortsInput): EvalPorts {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-eval-"));
  const config: Config = {
    dataSource: input.fixture === undefined ? "platform" : "store",
    llm: { provider: "openrouter", model: input.model, apiKey: input.apiKey },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: contextWindowForModel(input.model),
    dataDir,
  };
  const language = createNpmCoachLanguage(dataDir);
  const adapted = createEngineHostAdapter({
    catalog: bundledAcceptedCatalog(),
    config,
    stateReader: legacyStateReader,
    overrides: {
      language,
      ...(input.fixture === undefined ? {} : { athleteData: createFixtureReader(input.fixture) }),
      calendarMutations: recordingCalendar(input.recorder),
    },
  });
  const gate = new ConfirmationGate();
  const base = adapted.ports;
  const ports: EngineHostPorts = {
    ...base,
    memory: recordingMemory(base.memory, input.recorder),
    usage: {
      append: (line) => {
        input.recorder.usage.push(line);
        if (line.kind === "generate") input.meter.record(line);
        base.usage.append(line);
      },
    },
    toolConfirmations: confirmationPort(gate, input.recorder, language),
    modelTransportDecorator: recordingDecorator(input.recorder, input.meter),
  };
  return {
    ports,
    gate,
    dispose: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

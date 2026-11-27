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
  PlanningReadPort,
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
import {
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  createStoreAthleteDataReader,
} from "../../packages/core/src/athlete-data.js";
import {
  ConfirmationGate,
  createProposalSummarizers,
  createToolConfirmationPort,
} from "../../packages/core/src/agent/confirmation-gate.js";
import {
  UNPARSED_TOOL,
  type ExecutedWrite,
  type Proposal,
  type ToolAttempt,
  type ToolResult,
  type TurnObservation,
} from "./checks.js";
import type { EvalCase } from "./cases.js";
import { buildStoreFixture, dateKey, type StoreFixture } from "./fixture.js";
import { buildIntervalsFixture, type IntervalsFixture } from "./fixture-intervals.js";
import type { SpendMeter } from "./spend.js";

export type Channel = "desktop" | "telegram" | "cli";

export const CHAT_IDS: Readonly<Record<Channel, string>> = {
  desktop: "desktop",
  telegram: "4242",
  cli: "cli",
};

export type EvalData =
  | { readonly kind: "store"; readonly fixture: StoreFixture }
  | { readonly kind: "intervals"; readonly fixture: IntervalsFixture }
  | { readonly kind: "reads-failing" }
  | { readonly kind: "not-connected" };

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
  readonly results: ToolResult[] = [];
  readonly proposals: Proposal[] = [];
  readonly writes: ExecutedWrite[] = [];
  readonly usage: UsageLedgerLine[] = [];
  private readonly approvalCodes = new Set<string>();
  private offered = new Set<string>();
  private mark = { attempts: 0, results: 0, proposals: 0, writes: 0 };

  offer(names: readonly string[]): void {
    for (const name of names) this.offered.add(name);
  }

  startTurn(): void {
    this.offered = new Set();
    this.mark = {
      attempts: this.attempts.length,
      results: this.results.length,
      proposals: this.proposals.length,
      writes: this.writes.length,
    };
  }

  finishTurn(reply: string, pending: { readonly nonce: string } | undefined): TurnObservation {
    if (pending !== undefined) this.approvalCodes.add(pending.nonce);
    return {
      reply,
      offeredTools: Array.from(this.offered),
      attempts: this.attempts.slice(this.mark.attempts),
      results: this.results.slice(this.mark.results),
      proposals: this.proposals.slice(this.mark.proposals),
      pendingProposal: pending !== undefined,
      approvalCodes: Array.from(this.approvalCodes),
      writes: this.writes.slice(this.mark.writes),
    };
  }
}

const KEY_REJECTED_STATUS: ReadonlySet<number> = new Set([401, 402, 403]);

export function keyRejection(error: unknown): string | undefined {
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

function recordResults(name: string, tool: Tool, recorder: CaseRecorder): Tool["execute"] {
  const execute = tool.execute;
  if (execute === undefined) return undefined;
  return async (input, options) => {
    const output: unknown = await execute(input, options);
    recorder.results.push({ tool: name, output });
    return output;
  };
}

function recordAttempts(name: string, tool: Tool, recorder: CaseRecorder, log: CallLog): Tool {
  const schema = asSchema(tool.inputSchema);
  const execute = recordResults(name, tool, recorder);
  return {
    ...tool,
    ...(execute === undefined ? {} : { execute }),
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

export function evalDataFor(evalCase: EvalCase, today: Date): EvalData {
  switch (evalCase.data) {
    case "not-connected":
      return { kind: "not-connected" };
    case "reads-failing":
      return { kind: "reads-failing" };
    case "intervals":
    case "intervals-close-rides":
      return { kind: "intervals", fixture: buildIntervalsFixture(evalCase.data, today, evalCase.injection) };
    default:
      return { kind: "store", fixture: buildStoreFixture(evalCase.data, today) };
  }
}

export function createFixtureReader(data: EvalData): AthleteDataReaderPort | undefined {
  switch (data.kind) {
    case "store":
      return createStoreAthleteDataReader({
        snapshot: () => data.fixture.snapshot,
        canonicalActivities: data.fixture.activities,
      });
    case "intervals":
      return createPlatformAthleteDataReader(data.fixture.client);
    case "reads-failing":
      return createStoreAthleteDataReader({ snapshot: () => undefined });
    case "not-connected":
      return undefined;
  }
}

export function recordingCalendar(
  recorder: CaseRecorder,
  client?: IntervalsClient,
): PlatformCalendarMutationsPort {
  let nextEventId = 8_001;
  const write = (operation: string, input: unknown): void => {
    recorder.writes.push({ target: "calendar", operation, input });
  };
  return {
    createEvent: async (input) => {
      write("createEvent", input);
      return { id: nextEventId++, ...input };
    },
    readEventForDelete: async ({ eventId }) => {
      if (client === undefined) throw new Error(`The eval calendar holds no event ${eventId}.`);
      return createPlatformCalendarMutations(client).readEventForDelete({ eventId });
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

export function desktopRequiresConfirmation({ chatId }: { readonly chatId: string }): boolean {
  return chatId !== "desktop" && chatId !== "cli" && !chatId.startsWith("cli:");
}

function confirmationPort(
  gate: ConfirmationGate,
  recorder: CaseRecorder,
  language: ReturnType<typeof createNpmCoachLanguage>,
  data: EvalData,
): ToolConfirmationPort {
  const intervals =
    data.kind === "intervals"
      ? data.fixture.client
      : new IntervalsClient({ apiKey: "coach-eval", athleteId: "0", fetch: refuseNetwork });
  const port = createToolConfirmationPort({
    gate,
    language,
    summarizers: createProposalSummarizers({ intervals, tz: "UTC" }),
    requiresConfirmation: data.kind === "intervals" ? () => true : desktopRequiresConfirmation,
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
  readonly data: EvalData;
  readonly today: Date;
  readonly recorder: CaseRecorder;
  readonly meter: SpendMeter;
}

function platformPorts(input: EvalPortsInput, base: EngineHostPorts): EngineHostPorts["platform"] {
  const reader = createFixtureReader(input.data);
  if (input.data.kind !== "intervals") {
    return { ...base.platform, ...(reader === undefined ? {} : { athleteData: reader }) };
  }
  return {
    legacyClient: input.data.fixture.client,
    athleteData: reader,
    calendarMutations: recordingCalendar(input.recorder, input.data.fixture.client),
  };
}

function noPlanReadModel(today: Date): PlanningReadPort {
  return {
    getPlanningReadModel: async () => ({
      schemaVersion: 1,
      status: "no-plan",
      asOfDateKey: Number(dateKey(today, 0).replaceAll("-", "")),
      plan: null,
    }),
  };
}

export interface EvalPorts {
  readonly ports: EngineHostPorts;
  readonly gate: ConfirmationGate;
  readonly dispose: () => void;
}

export function createEvalPorts(input: EvalPortsInput): EvalPorts {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-eval-"));
  const config: Config = {
    dataSource: input.data.kind === "store" || input.data.kind === "reads-failing" ? "store" : "platform",
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
      calendarMutations: recordingCalendar(input.recorder),
    },
  });
  const gate = new ConfirmationGate();
  const base = adapted.ports;
  const desktopApp = input.data.kind === "store" || input.data.kind === "reads-failing";
  const ports: EngineHostPorts = {
    ...base,
    platform: platformPorts(input, base),
    ...(desktopApp ? { planningRead: noPlanReadModel(input.today) } : {}),
    memory: recordingMemory(base.memory, input.recorder),
    usage: {
      append: (line) => {
        input.recorder.usage.push(line);
        if (line.kind === "generate") input.meter.record(line);
        base.usage.append(line);
      },
    },
    toolConfirmations: confirmationPort(gate, input.recorder, language, input.data),
    modelTransportDecorator: recordingDecorator(input.recorder, input.meter),
  };
  return {
    ports,
    gate,
    dispose: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

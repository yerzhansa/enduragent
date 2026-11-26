import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema, jsonSchema, type Tool, type ToolSet } from "ai";
import { IntervalsClient } from "intervals-icu-api";
import type {
  AthleteDataReaderPort,
  AthleteReadResult,
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
import {
  ConfirmationGate,
  createProposalSummarizers,
  createToolConfirmationPort,
} from "../../packages/core/src/agent/confirmation-gate.js";
import type { ExecutedWrite, Proposal, ToolAttempt, TurnObservation } from "./checks.js";
import type { AthleteFixture } from "./fixture.js";
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

function recordAttempts(name: string, tool: Tool, recorder: CaseRecorder): Tool {
  const schema = asSchema(tool.inputSchema);
  return {
    ...tool,
    inputSchema: jsonSchema(() => schema.jsonSchema, {
      validate: async (value: unknown) => {
        const result =
          schema.validate === undefined
            ? { success: true as const, value }
            : await schema.validate(value);
        recorder.attempts.push({ tool: name, input: value, valid: result.success });
        return result;
      },
    }),
  };
}

export function recordingDecorator(
  recorder: CaseRecorder,
  meter: SpendMeter,
): ModelTransportDecorator {
  return (next) => ({
    generate: async (request) => {
      meter.assertBelowLimit();
      const tools = request.options.tools;
      if (tools !== undefined) recorder.offer(Object.keys(tools));
      const recordedTools: ToolSet | undefined =
        tools === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(tools).map(([name, tool]) => [name, recordAttempts(name, tool, recorder)]),
            );
      try {
        return await next.generate({
          ...request,
          options: { ...request.options, tools: recordedTools },
        });
      } catch (error) {
        meter.recordFailedCall();
        throw error;
      }
    },
  });
}

const STORE_UNAVAILABLE = {
  ok: false,
  error: "store_read_unavailable",
  message: "No complete local training-store snapshot is available.",
} as const;

function inRange(day: string, start: string, end: string | undefined): boolean {
  return day >= start && (end === undefined || day <= end);
}

function failingReader(): AthleteDataReaderPort {
  const unavailable = async (): Promise<AthleteReadResult<never>> => STORE_UNAVAILABLE;
  return {
    getAthlete: unavailable,
    listWellness: unavailable,
    listActivities: unavailable,
    getActivity: unavailable,
    getStreams: unavailable,
    listCalendar: unavailable,
    freshness: () => undefined,
  };
}

export function createFixtureReader(fixture: AthleteFixture | "failing"): AthleteDataReaderPort {
  if (fixture === "failing") return failingReader();
  const find = (id: string) => fixture.activities.find((activity) => String(activity.id) === id);
  return {
    getAthlete: async () => ({ ok: true, value: fixture.athlete }),
    listWellness: async ({ start, end }) => ({
      ok: true,
      value: fixture.wellness.filter((day) => inRange(day.id, start, end)),
    }),
    listActivities: async ({ start, end }) => ({
      ok: true,
      value: fixture.activities
        .filter((activity) => inRange(activity.startDateLocal.slice(0, 10), start, end))
        .sort((a, b) => b.startDateLocal.localeCompare(a.startDateLocal)),
    }),
    getActivity: async ({ id }) => {
      const activity = find(id);
      return activity === undefined
        ? { ok: false, error: "not_found", message: `No activity ${id}.` }
        : { ok: true, value: { ...activity, laps: fixture.laps(activity.id) } };
    },
    getStreams: async ({ id, keys }) => {
      const activity = find(id);
      if (activity === undefined) return { ok: false, error: "not_found", message: `No activity ${id}.` };
      const streams = fixture.streams(activity.id);
      return {
        ok: true,
        value: Object.fromEntries(Object.entries(streams).filter(([key]) => keys.includes(key))),
      };
    },
    listCalendar: async () => ({ ok: true, value: [] }),
    freshness: () => undefined,
  };
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
  readonly fixture: AthleteFixture | "failing" | undefined;
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

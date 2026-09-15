import { createNpmCoachLanguage } from "../language-preference.js";
import type { CoachLanguage } from "@enduragent/i18n";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AthleteDataReaderPort,
  AthleteStateReaderPort,
  EngineConfig,
  EngineHostPorts,
  EngineResolvedModelProfiles,
  ModelTransportDecorator,
  PlatformCalendarMutationsPort,
  ReferenceStateSnapshot,
} from "@enduragent/engine";
import { resolveUserTimezone } from "@enduragent/engine/sport";
import { ErrorStateSchema, LatestJsonSchema } from "@enduragent/kernel/reference/schemas";
import type { Config } from "../config.js";
import type { AcceptedModelCatalogRecord } from "../model-catalog.js";
import {
  persistResolvedModelProfiles,
  resolveModelRuntimeGeneration,
} from "../model-runtime-generation.js";
import {
  createMissingPlatformCalendarMutations,
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
} from "../athlete-data.js";
import { getFreshToken } from "../auth/profiles.js";
import { safeReadJson } from "../io/safe-read-json.js";
import { createSubsystemLogger } from "../logging/index.js";
import { Memory } from "../memory/store.js";
import { resolveSecretRef } from "../secrets/resolve.js";
import { appendUsageLine } from "../usage-ledger.js";
import { makeChatClient } from "../reference/sync/intervals-client-factory.js";
import { createConversationStore, type ConversationStorePort } from "./conversation-store.js";
import {
  createProposalSummarizers,
  createToolConfirmationPort,
  type ConfirmationGate,
} from "./confirmation-gate.js";
import { classifyFailure, extractRetryAfterMs } from "./token-utils.js";

export interface EngineHostAdapterOverrides {
  readonly language?: CoachLanguage;
  readonly athleteData?: AthleteDataReaderPort;
  readonly calendarMutations?: PlatformCalendarMutationsPort;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
  readonly confirmations?: ConfirmationGate;
}

export type EngineConfigProjectionOptions =
  | {
      readonly catalog: AcceptedModelCatalogRecord;
      readonly profileStorageDirectory?: string;
    }
  | {
      readonly models: EngineResolvedModelProfiles;
    };

export function engineConfigFromConfig(
  config: Config,
  options: EngineConfigProjectionOptions,
): EngineConfig {
  if ("models" in options) {
    return freezeEngineConfig(config, options.models);
  }
  if (!("catalog" in options)) {
    throw new TypeError("engineConfigFromConfig requires catalog or models");
  }
  const compactModel = config.llm.compactModel ?? config.llm.model;
  const flushModel = config.llm.flushModel ?? config.llm.model;
  return freezeEngineConfig(
    config,
    resolveModelRuntimeGeneration({
      catalog: options.catalog,
      provider: config.llm.provider,
      chatModel: config.llm.model,
      compactModel,
      flushModel,
      ...(config.contextWindowTokensOverride === undefined
        ? {}
        : { chatContextWindowTokensOverride: config.contextWindowTokensOverride }),
      profileStorageDirectory:
        options.profileStorageDirectory ?? join(config.dataDir, "config", "model-catalog"),
    }),
  );
}

function freezeEngineConfig(config: Config, models: EngineResolvedModelProfiles): EngineConfig {
  const { claudeCli, codexAgent, ...llm } = config.llm;
  return Object.freeze({
    dataSource: config.dataSource,
    llm: Object.freeze({
      ...llm,
      ...(claudeCli === undefined
        ? {}
        : {
            claudeCli: Object.freeze({
              ...claudeCli,
              cursorStorePath: join(config.dataDir, "claude-cli-sessions.json"),
            }),
          }),
      ...(codexAgent === undefined ? {} : { codexAgent: Object.freeze({ ...codexAgent }) }),
    }),
    session: Object.freeze({ ...config.session }),
    models,
    contextWindowTokens: models.chat.contextWindowTokens,
    compactContextWindowTokens: models.compact.contextWindowTokens,
  });
}

export function createEngineHostAdapter(
  input: {
    readonly config: Config;
    readonly stateReader: AthleteStateReaderPort;
    readonly overrides?: EngineHostAdapterOverrides;
  } & (
    | { readonly catalog: AcceptedModelCatalogRecord }
    | { readonly models: EngineResolvedModelProfiles }
  ),
): {
  readonly ports: EngineHostPorts;
  readonly memory: Memory;
  readonly conversationStore: ConversationStorePort;
} {
  const { config } = input;
  const overrides = input.overrides ?? {};
  let engineConfig: EngineConfig;
  if ("models" in input) {
    engineConfig = engineConfigFromConfig(config, { models: input.models });
  } else if ("catalog" in input) {
    engineConfig = engineConfigFromConfig(config, { catalog: input.catalog });
    persistResolvedModelProfiles(
      join(config.dataDir, "config", "model-catalog"),
      engineConfig.models,
    );
  } else {
    throw new TypeError("createEngineHostAdapter requires catalog or models");
  }
  const coachLanguage = overrides.language ?? createNpmCoachLanguage(config.dataDir);
  const memory = new Memory(config.dataDir, config.session.timezone || "UTC");
  const conversationStore = createConversationStore(
    config.dataDir,
    config.session.resetArchiveRetentionDays,
  );
  const legacyClient = config.intervals.apiKey
    ? makeChatClient({
        apiKey: config.intervals.apiKey,
        athleteId: config.intervals.athleteId,
      })
    : null;
  const athleteData =
    config.dataSource === "store"
      ? overrides.athleteData
      : legacyClient === null
        ? undefined
        : createPlatformAthleteDataReader(legacyClient);
  const calendarMutations =
    overrides.calendarMutations ??
    (legacyClient === null
      ? createMissingPlatformCalendarMutations()
      : createPlatformCalendarMutations(legacyClient));
  const tz = resolveUserTimezone(config.session.timezone);
  const toolConfirmations =
    overrides.confirmations === undefined
      ? undefined
      : createToolConfirmationPort({
          language: coachLanguage,
          gate: overrides.confirmations,
          summarizers: createProposalSummarizers({ intervals: legacyClient, tz }),
        });
  const referenceDir = join(config.dataDir, "data");
  const readReferenceState = (): ReferenceStateSnapshot => ({
    errorState: safeReadJson(join(referenceDir, "error_state.json"), ErrorStateSchema),
    latest: safeReadJson(join(referenceDir, "latest.json"), LatestJsonSchema),
  });
  return {
    memory,
    conversationStore,
    ports: {
      config: engineConfig,
      language: { resolveFor: ({ athleteText }) => coachLanguage.resolveFor({ athleteText }) },
      memory,
      chatStore: conversationStore,
      transcriptWriter: conversationStore,
      coachDecisions: conversationStore,
      secrets: { resolve: resolveSecretRef },
      platform: { legacyClient, athleteData, calendarMutations },
      logger: createSubsystemLogger("agent", config.dataDir),
      usage: { append: (line) => appendUsageLine(config.dataDir, line) },
      stateReader: input.stateReader,
      readReferenceState,
      getAccessToken: getFreshToken,
      classifyFailure,
      extractRetryAfterMs,
      now: Date.now,
      randomId: randomUUID,
      modelTransportDecorator: overrides.modelTransportDecorator,
      onToolsAssembled: overrides.onToolsAssembled,
      toolConfirmations,
    },
  };
}

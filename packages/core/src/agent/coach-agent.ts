import type { CoachLanguage } from "@enduragent/i18n";
import {
  createCoachEngine as createCanonicalCoachEngine,
  type ModelTransportDecorator,
} from "@enduragent/engine";
import type {
  AnswerCoachDecisionRpcParams,
  AnswerCoachDecisionRpcResult,
  AthleteState,
  ChatRequest,
  ChatResponse,
  CoachEngine,
  GetCoachDecisionRpcParams,
  GetCoachDecisionRpcResult,
  HasSessionRequest,
  HasSessionResponse,
  ResetSessionRequest,
  ResetSessionResponse,
  ResumeCoachDecisionRpcParams,
  ResumeCoachDecisionRpcResult,
  SkipCoachDecisionRpcParams,
  SkipCoachDecisionRpcResult,
  TurnEvent,
} from "@enduragent/coach-contract";
import type { AthleteDataReader, PlatformCalendarMutations } from "../athlete-data.js";
import type { Config } from "../config.js";
import type { Memory } from "../memory/store.js";
import type { Sport } from "../sport.js";
import { ConfirmationGate } from "./confirmation-gate.js";
import { createEngineHostAdapter } from "./engine-host-adapter.js";
import { legacyStateReader } from "./legacy-athlete-state-reader.js";

export interface LegacyAgentOverrides {
  readonly language?: CoachLanguage;
  readonly athleteData?: AthleteDataReader;
  readonly calendarMutations?: PlatformCalendarMutations;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
}

export class CoachAgent implements CoachEngine {
  private readonly engine: CoachEngine;
  private readonly memory: Memory;
  readonly confirmations = new ConfirmationGate();

  constructor(sport: Sport, config: Config, overrides: LegacyAgentOverrides = {}) {
    const adapted = createEngineHostAdapter({
      config,
      stateReader: legacyStateReader,
      overrides: { ...overrides, confirmations: this.confirmations },
    });
    this.memory = adapted.memory;
    this.engine = createCanonicalCoachEngine({ sport, ports: adapted.ports });
  }

  chat(request: ChatRequest, onEvent?: (event: TurnEvent) => void): Promise<ChatResponse> {
    return this.engine.chat(request, onEvent);
  }

  getCoachDecision(request: GetCoachDecisionRpcParams): Promise<GetCoachDecisionRpcResult> {
    return this.engine.getCoachDecision(request);
  }

  answerCoachDecision(
    request: AnswerCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<AnswerCoachDecisionRpcResult> {
    return this.engine.answerCoachDecision(request, onEvent);
  }

  skipCoachDecision(request: SkipCoachDecisionRpcParams): Promise<SkipCoachDecisionRpcResult> {
    return this.engine.skipCoachDecision(request);
  }

  resumeCoachDecision(
    request: ResumeCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ResumeCoachDecisionRpcResult> {
    return this.engine.resumeCoachDecision(request, onEvent);
  }

  hasSession(request: HasSessionRequest): Promise<HasSessionResponse> {
    return this.engine.hasSession(request);
  }

  resetSession(request: ResetSessionRequest): Promise<ResetSessionResponse> {
    return this.engine.resetSession(request);
  }

  getAthleteState(): Promise<AthleteState> {
    return this.engine.getAthleteState();
  }

  getMemory(): Memory {
    return this.memory;
  }
}

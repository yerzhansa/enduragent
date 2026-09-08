import type { CoachLanguage } from "@enduragent/i18n";
import type { Config } from "../config.js";
import type { Sport } from "../sport.js";
import type { Memory } from "../memory/store.js";
import type { CoachEngine, SettleRequest } from "@enduragent/coach-contract";
import type { ConfirmationGate } from "./confirmation-gate.js";
import { CoachAgent } from "./coach-agent.js";
import type { AthleteDataReader, PlatformCalendarMutations } from "../athlete-data.js";
import type { ModelTransportDecorator } from "@enduragent/engine";

/**
 * In-process canonical engine handle plus the one composition-root
 * accessor that cannot cross a wire boundary — the Memory instance the
 * startup hook mutates before any channel is reachable.
 */
export interface LocalCoachEngine extends CoachEngine {
  readonly confirmations: ConfirmationGate;
  getMemory(): Memory;
  settle(request?: SettleRequest): Promise<void>;
}

export interface LegacyEngineOverrides {
  readonly language?: CoachLanguage;
  readonly athleteData?: AthleteDataReader;
  readonly calendarMutations?: PlatformCalendarMutations;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
}

export function createCoachEngine(
  sport: Sport,
  config: Config,
  deps?: LegacyEngineOverrides,
): LocalCoachEngine {
  return deps === undefined ? new CoachAgent(sport, config) : new CoachAgent(sport, config, deps);
}

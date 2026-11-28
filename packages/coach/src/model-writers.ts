import type { EngineHostPorts, IntentTranslationPort } from "@enduragent/engine";
import { createCoachTextModelWriter } from "@enduragent/engine/coach-text-writer";
import type { RuntimeBundle } from "./runtime-bundle.js";

export function modelWriters(
  backend: Partial<IntentTranslationPort>,
  ports: EngineHostPorts,
  configured: boolean,
): Pick<RuntimeBundle, "intentTranslator" | "coachText"> {
  if (!configured) return {};
  return {
    ...(backend.translateIntent === undefined
      ? {}
      : { intentTranslator: { translateIntent: backend.translateIntent.bind(backend) } }),
    coachText: createCoachTextModelWriter(ports),
  };
}

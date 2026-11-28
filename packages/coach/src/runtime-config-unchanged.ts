import { isDeepStrictEqual } from "node:util";
import type { Config } from "@enduragent/core";

function definedFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === undefined ? [] : [[key, definedFields(field)]],
    ),
  );
}

export function runtimeConfigUnchanged(current: Config, candidate: Config): boolean {
  return (["llm", "intervals", "session"] as const).every((slot) =>
    isDeepStrictEqual(definedFields(current[slot]), definedFields(candidate[slot])),
  );
}

import type { MemorySectionSpec, Sport } from "../sport.js";
import { CORE_SHARED_SECTIONS } from "./shared-sections.js";

const WARNED_ONCE_PER_PROCESS = new Set<string>();

const CORE_NAMES: ReadonlySet<string> = new Set(CORE_SHARED_SECTIONS.map((s) => s.name));

function warnOnce(key: string, message: string): void {
  if (WARNED_ONCE_PER_PROCESS.has(key)) return;
  WARNED_ONCE_PER_PROCESS.add(key);
  console.warn(message);
}

export function getEffectiveSections(sport: Sport): readonly MemorySectionSpec[] {
  const seen = new Map<string, MemorySectionSpec>();
  for (const spec of CORE_SHARED_SECTIONS) {
    seen.set(spec.name, { ...spec, ...sport.coreSectionText?.[spec.name] });
  }
  const sportNamesSeen = new Set<string>();
  for (const spec of sport.memorySections) {
    if (sportNamesSeen.has(spec.name)) {
      warnOnce(
        `${sport.id}:${spec.name}:self-dup`,
        `Sport "${sport.id}" declares section "${spec.name}" more than once in ` +
          `memorySections; using the first occurrence.`,
      );
      continue;
    }
    sportNamesSeen.add(spec.name);
    if (CORE_NAMES.has(spec.name)) {
      warnOnce(
        `${sport.id}:${spec.name}:core-collision`,
        `Sport "${sport.id}" declares section "${spec.name}" which is Core-shared; ` +
          `using Core's spec. Remove from sport.memorySections to silence this warning.`,
      );
      continue;
    }
    seen.set(spec.name, spec);
  }
  return Array.from(seen.values());
}

export function _resetWarnCacheForTesting(): void {
  WARNED_ONCE_PER_PROCESS.clear();
}

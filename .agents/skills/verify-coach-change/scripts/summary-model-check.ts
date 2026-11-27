// Exhaustive check of how the coach picks the summary (compaction) model and
// the memory-save (flush) model, run on the real resolveRuntimeConfig.
//
// The state is the coach's LLM config plus what the athlete explicitly chose.
// The steps are the requests the desktop and the loader really send. A
// breadth-first search runs every step from every reachable state until no new
// state appears, so it covers every sequence of steps of any length over the
// alphabet below, and each counterexample is a shortest one.
//
// Run: pnpm exec tsx .agents/skills/verify-coach-change/scripts/summary-model-check.ts

import {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  resolveRuntimeConfig,
  type EffectiveRuntimeConfig,
  type LlmProvider,
  type RuntimeConfigPatch,
} from "../../../../packages/core/src/runtime-config.ts";
import { GENERATED_MODEL_CATALOG_SEED } from "../../../../packages/core/src/model-catalog-seed.generated.ts";

const ASTRA = "gpt-6-astra"; // runtime-config.ts isModelEnabledForProvider
const PROVIDERS = ["openai", "openrouter", "anthropic"] as const satisfies readonly LlmProvider[];
type Provider = (typeof PROVIDERS)[number];

// Every model the shipped list offers for these providers, plus the provider's
// summary default (an athlete can type it as the chat model with "Other model…").
function listedModels(provider: Provider): readonly string[] {
  const entry = GENERATED_MODEL_CATALOG_SEED.providers.find((p) => p.providerId === provider);
  if (entry === undefined) throw new Error(`model list seed has no ${provider}`);
  const ids = new Set<string>(entry.models.map((m) => m.modelId));
  ids.add(DEFAULT_MODELS[provider]);
  const compactDefault = (COMPACT_MODEL_DEFAULTS as Partial<Record<string, string>>)[provider];
  if (compactDefault !== undefined) ids.add(compactDefault);
  return [...ids].sort();
}
const MODELS: Record<Provider, readonly string[]> = {
  openai: listedModels("openai"),
  openrouter: listedModels("openrouter"),
  anthropic: listedModels("anthropic"),
};
if (!MODELS.openai.includes(ASTRA)) throw new Error("model list seed has no GPT-6 Astra");

// What the athlete chose. Only an explicit request sets these.
interface Ghost {
  readonly explicitCompact: string | null;
  readonly explicitFlush: string | null;
  readonly beforeAstra: string | null; // the chat model the athlete left for Astra
}

interface State {
  readonly config: EffectiveRuntimeConfig;
  readonly ghost: Ghost;
}

interface Step {
  readonly words: string; // the request in the code's words
  readonly kind: "setup" | "coach" | "explicit" | "restart";
  readonly next: (state: State) => State | "refused";
}

// composition.ts runtimePatch (lines 350-372) for the LLM part of a
// configureRuntime request, mirrored field by field.
interface LlmRequest {
  readonly provider?: Provider;
  readonly model?: string;
  readonly api_key?: string;
  readonly flush_model?: string | null;
  readonly compact_model?: string | null;
}
function runtimePatch(llm: LlmRequest): RuntimeConfigPatch {
  return {
    llm: {
      provider: llm.provider,
      model: llm.model,
      apiKey: llm.api_key,
      baseUrl: undefined,
      flushModel: llm.flush_model,
      compactModel: llm.compact_model,
    },
  };
}

function apply(state: State, llm: LlmRequest, ghost: Ghost): State | "refused" {
  try {
    return { config: resolveRuntimeConfig(runtimePatch(llm), state.config), ghost };
  } catch {
    return "refused";
  }
}

const KEY = "sk-synthetic-test-key";

function modelGhost(state: State, model: string, providerChanged: boolean): Ghost {
  const previous = state.config.llm.model;
  const beforeAstra =
    model !== ASTRA
      ? null
      : providerChanged
        ? null
        : previous === ASTRA
          ? state.ghost.beforeAstra
          : previous;
  return providerChanged
    ? { explicitCompact: null, explicitFlush: null, beforeAstra }
    : { ...state.ghost, beforeAstra };
}

// Step order only breaks ties between paths of equal length: a Settings
// → Coach pick reads closer to the athlete's story than a repeated Setup save.
const ORDER: Record<Step["kind"], number> = { coach: 0, explicit: 1, setup: 2, restart: 3 };
const steps: Step[] = [];
for (const provider of PROVIDERS) {
  for (const model of MODELS[provider]) {
    // Setup saves a key with a provider and a model:
    // llm-selection.ts runtimeConfigurationForSelection.
    steps.push({
      kind: "setup",
      words: `Setup saves the key: configureRuntime ${JSON.stringify({ llm: { provider, model, api_key: "…" } })}`,
      next: (state) =>
        apply(
          state,
          { provider, model, api_key: KEY },
          modelGhost(state, model, state.config.llm.provider !== provider),
        ),
    });
    // Settings → Coach changes only the model on the active provider:
    // llm-selection.ts runtimeConfigurationForExistingSelection.
    steps.push({
      kind: "coach",
      words: `Settings → Coach picks a model: configureRuntime ${JSON.stringify({ llm: { model } })}`,
      next: (state) =>
        state.config.llm.provider !== provider
          ? "refused"
          : apply(state, { model }, modelGhost(state, model, false)),
    });
    // An explicit summary or memory model (config.yaml, LLM_*_MODEL, or the
    // configureRuntime fields compact_model and flush_model in rpc.ts).
    steps.push({
      kind: "explicit",
      words: `the athlete sets the summary model: configureRuntime ${JSON.stringify({ llm: { compact_model: model } })}`,
      next: (state) =>
        state.config.llm.provider !== provider
          ? "refused"
          : apply(state, { compact_model: model }, { ...state.ghost, explicitCompact: model }),
    });
    steps.push({
      kind: "explicit",
      words: `the athlete sets the memory model: configureRuntime ${JSON.stringify({ llm: { flush_model: model } })}`,
      next: (state) =>
        state.config.llm.provider !== provider
          ? "refused"
          : apply(state, { flush_model: model }, { ...state.ghost, explicitFlush: model }),
    });
  }
}
steps.push({
  kind: "explicit",
  words: `the athlete clears the summary model: configureRuntime {"llm":{"compact_model":null}}`,
  next: (state) => apply(state, { compact_model: null }, { ...state.ghost, explicitCompact: null }),
});
steps.push({
  kind: "explicit",
  words: `the athlete clears the memory model: configureRuntime {"llm":{"flush_model":null}}`,
  next: (state) => apply(state, { flush_model: null }, { ...state.ghost, explicitFlush: null }),
});
// Restart: composition.ts persistConfig writes flush_model and compact_model
// (lines 500-501) and config.ts loadConfig reads them back with no current
// config (lines 313-321).
steps.push({
  kind: "restart",
  words: "the app restarts and reloads config.yaml",
  next: (state) => {
    const llm = state.config.llm;
    try {
      const config = resolveRuntimeConfig({
        llm: {
          provider: llm.provider,
          model: llm.model,
          apiKey: llm.apiKey,
          flushModel: llm.flushModel,
          compactModel: llm.compactModel,
          baseUrl: llm.baseUrl,
        },
      });
      return { config, ghost: state.ghost };
    } catch {
      return "refused";
    }
  },
});

steps.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);

// engine-host-adapter.ts:73-74: what the requests really use.
const usedCompact = (c: EffectiveRuntimeConfig): string => c.llm.compactModel ?? c.llm.model;
const usedFlush = (c: EffectiveRuntimeConfig): string => c.llm.flushModel ?? c.llm.model;

function astraBackground(state: State): string {
  return state.ghost.beforeAstra ?? DEFAULT_MODELS.openai;
}
const onAstra = (state: State): boolean =>
  state.config.llm.provider === "openai" && state.config.llm.model === ASTRA;

// The rule, in one sentence each:
// - Summaries run on the athlete's explicit choice; else on the provider's
//   summary default; else (no default) on the chat model; and while the chat
//   model is GPT-6 Astra, on the model the athlete used before Astra.
// - Memory saves run on the athlete's explicit choice; else on the chat model;
//   and while on GPT-6 Astra, on the model used before Astra.
function expectedCompact(state: State): string {
  if (state.ghost.explicitCompact !== null) return state.ghost.explicitCompact;
  if (onAstra(state)) return astraBackground(state);
  const compactDefault = (COMPACT_MODEL_DEFAULTS as Partial<Record<string, string>>)[
    state.config.llm.provider
  ];
  return compactDefault ?? state.config.llm.model;
}
function expectedFlush(state: State): string {
  if (state.ghost.explicitFlush !== null) return state.ghost.explicitFlush;
  if (onAstra(state)) return astraBackground(state);
  return state.config.llm.model;
}

interface Rule {
  readonly name: string;
  readonly sentence: string;
  // Checked on every reachable state, or only on states reached by a provider switch.
  readonly scope: "every-state" | "after-provider-switch";
  readonly holds: (state: State) => { ok: boolean; detail: string };
}
const summaryRule = (state: State) => ({
  ok: usedCompact(state.config) === expectedCompact(state),
  detail: `summaries run on ${usedCompact(state.config)}, expected ${expectedCompact(state)}`,
});
const memoryRule = (state: State) => ({
  ok: usedFlush(state.config) === expectedFlush(state),
  detail: `memory saves run on ${usedFlush(state.config)}, expected ${expectedFlush(state)}`,
});
const rules: Rule[] = [
  {
    name: "SummaryModelIsChosen",
    sentence:
      "Summaries run on the athlete's explicit choice, else the provider's summary default, else the chat model; on GPT-6 Astra, on the model used before Astra.",
    scope: "every-state",
    holds: summaryRule,
  },
  {
    name: "MemoryModelIsChosen",
    sentence:
      "Memory saves run on the athlete's explicit choice, else the chat model; on GPT-6 Astra, on the model used before Astra.",
    scope: "every-state",
    holds: memoryRule,
  },
  {
    name: "ProviderSwitchResetsBackgroundModels",
    sentence:
      "Right after the athlete switches provider in Setup, summaries and memory saves follow the rule above. Holds today (runtime-config.ts providerChanged branches).",
    scope: "after-provider-switch",
    holds: (state) => {
      const a = summaryRule(state);
      const b = memoryRule(state);
      return { ok: a.ok && b.ok, detail: `${a.detail}; ${b.detail}` };
    },
  },
];

function keyOf(state: State): string {
  const { apiKey: _apiKey, ...llm } = state.config.llm;
  return JSON.stringify([llm, state.ghost]);
}

// A fresh install: config.ts loads an empty config.yaml.
const initial: State = {
  config: resolveRuntimeConfig({ llm: {} }),
  ghost: { explicitCompact: null, explicitFlush: null, beforeAstra: null },
};

interface Node {
  readonly state: State;
  readonly parent: string | null;
  readonly via: Step | null;
}
const seen = new Map<string, Node>();
const queue: string[] = [];
const initialKey = keyOf(initial);
seen.set(initialKey, { state: initial, parent: null, via: null });
queue.push(initialKey);

function pathTo(key: string): string[] {
  const lines: string[] = [];
  let cursor: string | null = key;
  while (cursor !== null) {
    const node: Node = seen.get(cursor)!;
    if (node.via !== null) lines.unshift(node.via.words);
    cursor = node.parent;
  }
  return lines;
}

// First violation per rule and per final provider. BFS order makes it shortest.
interface Violation {
  readonly path: readonly string[];
  readonly state: State;
  readonly detail: string;
}
const violations = new Map<string, Violation>();
let transitions = 0;

function check(state: State, path: () => string[], viaProviderSwitch: boolean): void {
  for (const rule of rules) {
    if (rule.scope === "after-provider-switch" && !viaProviderSwitch) continue;
    const slot = `${rule.name} ${state.config.llm.provider}`;
    if (violations.has(slot)) continue;
    const result = rule.holds(state);
    if (!result.ok) violations.set(slot, { path: path(), state, detail: result.detail });
  }
}
check(initial, () => [], false);

while (queue.length > 0) {
  const key = queue.shift()!;
  const node = seen.get(key)!;
  for (const step of steps) {
    const next = step.next(node.state);
    if (next === "refused") continue;
    transitions += 1;
    const nextKey = keyOf(next);
    const switched =
      step.kind === "setup" && next.config.llm.provider !== node.state.config.llm.provider;
    // A provider switch is checked on every edge, even into a state seen before.
    check(next, () => [...pathTo(key), step.words], switched);
    if (seen.has(nextKey)) continue;
    seen.set(nextKey, { state: next, parent: key, via: step });
    queue.push(nextKey);
  }
}

console.log(`# Summary and memory model choice`);
console.log(
  `Checked ${seen.size} reachable states and ${transitions} steps from a fresh install, over providers ${PROVIDERS.join(", ")} and their listed models.`,
);
for (const rule of rules) {
  console.log(`\n## ${rule.name}\n${rule.sentence}`);
  for (const provider of PROVIDERS) {
    const found = violations.get(`${rule.name} ${provider}`);
    if (found === undefined) {
      console.log(`RESULT ${rule.name} ${provider} holds`);
      continue;
    }
    console.log(`RESULT ${rule.name} ${provider} breaks`);
    console.log(`Shortest path on ${provider}, ${found.path.length} steps:`);
    found.path.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    console.log(`  Now: chat model ${found.state.config.llm.model}; ${found.detail}.`);
  }
}

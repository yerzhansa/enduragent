// Exhaustive check of how the coach picks the summary (compaction) model and
// the memory-save (flush) model, run on the real resolveRuntimeConfig.
//
// The state is the coach's LLM config plus what the athlete explicitly chose.
// The steps are the requests the desktop and the loader really send. A
// breadth-first search runs every step from every reachable state until no new
// state appears, so it covers every sequence of steps of any length over the
// alphabet below, and each counterexample is a shortest one. It starts from a
// fresh install and from every config.yaml that main wrote after a Setup save,
// and after a Setup save followed by one Settings → Coach pick, so an install
// that upgrades is checked too.
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
import { assignPersistedLlmBackgroundModels } from "../../../../packages/core/src/background-model-persistence.ts";
import { loadConfigFromYaml } from "../../../../packages/core/src/config.ts";
import { GENERATED_MODEL_CATALOG_SEED } from "../../../../packages/core/src/model-catalog-seed.generated.ts";

const ASTRA = "gpt-6-astra"; // runtime-config.ts isModelEnabledForProvider

// loadConfigFromYaml reads these before config.yaml; the check reads only the file.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLM_") || key === "CONTEXT_WINDOW_TOKENS") delete process.env[key];
}

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
// Restart: composition.ts persistRuntimeConfig writes the llm block of
// config.yaml with assignPersistedLlmBackgroundModels, and config.ts
// loadConfigFromYaml reads it back with no current config.
type LlmYaml = Record<string, unknown>;
function load(llm: LlmYaml, ghost: Ghost): State | "refused" {
  try {
    return { config: loadConfigFromYaml({ llm }), ghost };
  } catch {
    return "refused";
  }
}
steps.push({
  kind: "restart",
  words: "the app restarts and reloads config.yaml",
  next: (state) => {
    const llm: LlmYaml = {
      provider: state.config.llm.provider,
      model: state.config.llm.model,
      api_key: state.config.llm.apiKey,
      ...(state.config.llm.baseUrl === undefined ? {} : { base_url: state.config.llm.baseUrl }),
    };
    assignPersistedLlmBackgroundModels(llm, state.config);
    return load(llm, state.ghost);
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
  return JSON.stringify([llm, state.config.llmBackgroundModels, state.ghost]);
}

// Start states. A fresh install: config.ts loads an empty config.yaml. And an
// install that upgrades from main, where persistRuntimeConfig wrote
// compact_model and flush_model as resolved: after a Setup save, compact_model
// is the provider's summary default, else the chat model, and flush_model is
// absent; on GPT-6 Astra both are the model the athlete used before Astra
// (gpt-6.2-sol from a fresh install or another provider). After a Setup save
// and one Settings → Coach pick, mainCoachPick below gives the file.
const NO_CHOICE: Ghost = { explicitCompact: null, explicitFlush: null, beforeAstra: null };
const starts: { readonly words: string | null; readonly state: State }[] = [
  { words: null, state: { config: resolveRuntimeConfig({ llm: {} }), ghost: NO_CHOICE } },
];
function startFromMain(llm: LlmYaml, ghost: Ghost, history = ""): void {
  const state = load(llm, ghost);
  if (state === "refused") throw new Error(`main's config.yaml refused: ${JSON.stringify(llm)}`);
  const { api_key: _key, ...shown } = llm;
  const words = `upgrade from main${history} with config.yaml llm ${JSON.stringify(shown)}`;
  starts.push({ words, state });
}
// main's resolveRuntimeConfig for a same-provider model change, mirrored from
// origin/main packages/core/src/runtime-config.ts (cad513a0a):
// - lines 570-575: the background model is the picked model; on GPT-6 Astra it
//   is the chat model before the pick (the Setup model is never Astra here);
// - lines 576-582: flush_model stays, else on GPT-6 Astra it is that model;
// - lines 584-595: compact_model moves to that model only when it equalled the
//   old chat model; otherwise it stays.
// The Setup model is never Astra: main's Setup on Astra leaves compact_model
// and flush_model on the model before Astra, and a later pick keeps both. After
// a pick to any other model they match no derived choice, so the loader keeps
// them as explicit (the PR's Tradeoffs).
function mainCoachPick(llm: LlmYaml, picked: string): { llm: LlmYaml; ghost: Ghost } {
  const previous = llm.model as string;
  const astra = llm.provider === "openai" && picked === ASTRA;
  const background = astra ? previous : picked;
  const flush = llm.flush_model ?? (astra ? background : undefined);
  return {
    llm: {
      ...llm,
      model: picked,
      compact_model: llm.compact_model === previous ? background : llm.compact_model,
      ...(flush === undefined ? {} : { flush_model: flush }),
    },
    ghost: { ...NO_CHOICE, beforeAstra: astra ? previous : null },
  };
}
for (const provider of PROVIDERS) {
  const compactDefault = (COMPACT_MODEL_DEFAULTS as Partial<Record<string, string>>)[provider];
  for (const model of MODELS[provider]) {
    if (model === ASTRA) continue;
    const setup = { provider, model, api_key: KEY, compact_model: compactDefault ?? model };
    startFromMain(setup, NO_CHOICE);
    for (const picked of MODELS[provider]) {
      if (picked === model) continue;
      const afterPick = mainCoachPick(setup, picked);
      const history = ` after Setup on ${model} and a Settings → Coach pick of ${picked}`;
      startFromMain(afterPick.llm, afterPick.ghost, history);
    }
    if (provider !== "openai") continue;
    const astra = {
      provider,
      model: ASTRA,
      api_key: KEY,
      compact_model: model,
      flush_model: model,
    };
    startFromMain(astra, { ...NO_CHOICE, beforeAstra: model });
    if (model === DEFAULT_MODELS.openai) startFromMain(astra, NO_CHOICE);
  }
}

interface Node {
  readonly state: State;
  readonly parent: string | null;
  readonly words: string | null;
}
const seen = new Map<string, Node>();
const queue: string[] = [];
const startKeys: string[] = [];
for (const start of starts) {
  const key = keyOf(start.state);
  startKeys.push(key);
  if (seen.has(key)) continue;
  seen.set(key, { state: start.state, parent: null, words: start.words });
  queue.push(key);
}

function pathTo(key: string): string[] {
  const lines: string[] = [];
  let cursor: string | null = key;
  while (cursor !== null) {
    const node: Node = seen.get(cursor)!;
    if (node.words !== null) lines.unshift(node.words);
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
for (const key of startKeys) check(seen.get(key)!.state, () => pathTo(key), false);

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
    seen.set(nextKey, { state: next, parent: key, words: step.words });
    queue.push(nextKey);
  }
}

console.log(`# Summary and memory model choice`);
console.log(
  `Checked ${seen.size} reachable states and ${transitions} steps from a fresh install and ${starts.length - 1} config.yaml files saved by main, over providers ${PROVIDERS.join(", ")} and their listed models.`,
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

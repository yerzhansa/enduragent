export type Step<S> = readonly [label: string, next: S];

export interface WalkSpec<S> {
  readonly initial: readonly S[];
  readonly next: (state: S) => readonly Step<S>[];
  readonly key: (state: S) => string;
  readonly rules: Readonly<Record<string, (state: S) => boolean>>;
  readonly maxDepth: number;
  readonly within?: (state: S) => boolean;
}

export interface BrokenRule {
  readonly rule: string;
  readonly path: readonly string[];
}

export interface WalkResult {
  readonly states: number;
  readonly broken: readonly BrokenRule[];
}

interface Visit<S> {
  readonly state: S;
  readonly path: readonly string[];
}

export function walk<S>(spec: WalkSpec<S>): WalkResult {
  const seen = new Set<string>();
  const broken = new Map<string, readonly string[]>();
  let frontier: Visit<S>[] = [];
  const visit = (state: S, path: readonly string[]): void => {
    const key = spec.key(state);
    if (seen.has(key)) return;
    seen.add(key);
    for (const [rule, holds] of Object.entries(spec.rules)) {
      if (!broken.has(rule) && !holds(state)) broken.set(rule, path);
    }
    if (spec.within === undefined || spec.within(state)) frontier.push({ state, path });
  };
  for (const state of spec.initial) visit(state, ["start"]);
  for (let depth = 0; depth < spec.maxDepth && frontier.length > 0; depth += 1) {
    const current = frontier;
    frontier = [];
    for (const { state, path } of current) {
      for (const [label, next] of spec.next(state)) visit(next, [...path, label]);
    }
  }
  return {
    states: seen.size,
    broken: [...broken].map(([rule, path]) => ({ rule, path })),
  };
}

export function replay<S>(
  start: S,
  steps: readonly (readonly [string, (state: S) => S])[],
): readonly S[] {
  const states = [start];
  let state = start;
  for (const [, apply] of steps) {
    state = apply(state);
    states.push(state);
  }
  return states;
}

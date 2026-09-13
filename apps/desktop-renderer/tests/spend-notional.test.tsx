import type { SpendRouteSummary, SpendSummary } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  createSpendSettingsAdapter,
  notionalSpendCopy,
  routeSpendCopy,
} from "../src/state/adapters/spend";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";

function route(overrides: Partial<SpendRouteSummary> = {}): SpendRouteSummary {
  return {
    provider: "claude-cli",
    model: "sonnet",
    generationCount: 3,
    pricedGenerationCount: 3,
    unpricedGenerationCount: 0,
    providerReportedGenerationCount: 0,
    knownSpendUsd: 0,
    notionalSpendUsd: 1.2345,
    cacheReadTokens: 0,
    cacheReadSavingsUsd: 0,
    caching: "provider-dependent",
    disclosure: null,
    ...overrides,
  };
}

function summary(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0,
    notionalSpendUsd: 1.2345,
    generationCount: 3,
    pricedGenerationCount: 3,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "below",
    cacheReadTokens: 0,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: true,
    routes: [route()],
    ...overrides,
  };
}

function adapter() {
  let state = EMPTY_SETTINGS_SURFACE.spend;
  const created = createSpendSettingsAdapter({
    publish: (next) => {
      state = next;
    },
  });
  return { view: created.view, current: () => state };
}

describe("notional spend copy", () => {
  it("renders subscription usage as a would-have-cost line, never as spend", () => {
    const copy = notionalSpendCopy(summary());

    expect(copy).toBe(
      "Subscription usage would have cost $1.23 on the API. No money moved, and it does not count toward your cap.",
    );
    expect(copy).not.toMatch(/spent|you paid/iu);
  });

  it("stays silent when no notional usage was recorded", () => {
    expect(notionalSpendCopy(summary({ notionalSpendUsd: 0 }))).toBeNull();
    const withoutField = summary();
    const { notionalSpendUsd: _omitted, ...rest } = withoutField;
    expect(notionalSpendCopy(rest as SpendSummary)).toBeNull();
  });

  it("prices a notional route without claiming money moved", () => {
    expect(routeSpendCopy(route())).toBe(
      "would have cost $1.23 on the API · 3/3 generations priced",
    );
  });

  it("shows both real and notional amounts when one route carries each", () => {
    expect(routeSpendCopy(route({ knownSpendUsd: 0.42 }))).toBe(
      "$0.42 · would have cost $1.23 on the API · 3/3 generations priced",
    );
  });

  it("keeps the plain spend line for routes that moved real money", () => {
    const { notionalSpendUsd: _omitted, ...actual } = route({ knownSpendUsd: 0.42 });
    expect(routeSpendCopy(actual as SpendRouteSummary)).toBe("$0.42 · 3/3 generations priced");
  });

  it("never raises the cap warning for a notional-only day above the cap", () => {
    const subject = adapter();

    subject.view.render({
      ...EMPTY_SETTINGS_SURFACE.spend,
      status: "ready",
      summary: summary(),
    });

    expect(subject.current().warning).toBeNull();
    expect(subject.current().summary?.knownSpendUsd).toBe(0);
  });

  it("still warns when real spend reaches the cap", () => {
    const subject = adapter();

    subject.view.render({
      ...EMPTY_SETTINGS_SURFACE.spend,
      status: "ready",
      summary: summary({
        knownSpendUsd: 0.5,
        capStatus: "reached",
        routes: [route({ knownSpendUsd: 0.5 })],
      }),
    });

    expect(subject.current().warning).toBe(
      "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
    );
  });
});

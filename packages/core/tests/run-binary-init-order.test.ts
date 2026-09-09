import { say } from "../src/cli-copy.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Outer init-order sanity check for `run-binary.ts`. The bulk of the
 * Reference init-order discipline lives inside `bootstrapReference()` and is
 * verified behaviorally in `reference-runtime.test.ts`. This file guards
 * only the outer sequence the binary orchestrates around it:
 *
 *   1. Composition preparation (after config/security checks)
 *   2. Memory (engine construction — the CoachAgent constructor runs inside createCoachEngine)
 *   3. Startup hook (binary-specific; cycling-coach's runs the legacy migrate)
 *   4. Reference bootstrap
 *   5. Telegram bot
 *
 * Reordering any of these is a correctness regression (future migration units'
 * bootstrap will read MEMORY.md and depends on the migration step having
 * completed). Refactors that move steps into other modules require updating
 * this list, which is intentional friction.
 */
describe("run-binary outer init order", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  const STEPS: ReadonlyArray<readonly [string, string]> = [
    ["1: Composition preparation", "hooks.prepare?.({ config, sport })"],
    ["2: Memory (engine construction)", "createCoachEngine("],
    ["3: Startup hook", "await runStartupHook("],
    ["4: Reference bootstrap", "await bootstrapReference("],
    ["5: Telegram bot constructed", "createTelegramBot("],
  ];

  it("each anchor appears exactly once", () => {
    for (const [label, anchor] of STEPS) {
      const matches = countOccurrences(src, anchor);
      expect.soft(matches, `${label} — anchor "${anchor}" should appear exactly once`).toBe(1);
    }
  });

  it("anchors appear in the documented order", () => {
    const positions = STEPS.map(([label, anchor]) => ({
      label,
      idx: src.indexOf(anchor),
    }));
    for (let i = 1; i < positions.length; i++) {
      expect
        .soft(positions[i].idx, `${positions[i].label} must come AFTER ${positions[i - 1].label}`)
        .toBeGreaterThan(positions[i - 1].idx);
    }
  });

  it("prepares only after the data directory security check", () => {
    expect(src.indexOf("hooks.prepare?.({ config, sport })")).toBeGreaterThan(
      src.indexOf("ensureDataDirSecure(config.dataDir)"),
    );
  });
});

/**
 * The shutdown-window latch: when a SIGTERM/SIGINT lands in the startup /
 * first-long-poll window, our own bot.stop() aborts the in-flight getUpdates,
 * which grammy surfaces as a rejected start-promise (abort / 409). That
 * rejection is the EXPECTED consequence of a graceful shutdown and must NOT
 * reach reportFatal (markUnclean + exit(1)) — otherwise it races and beats the
 * shutdown handler's clean exit(0), making shutdown success timing-dependent.
 *
 * The polling supervisor has focused behavioral tests; this source guard pins
 * runBinary's wiring to that seam and keeps signal ownership in the npm host.
 */
describe("run-binary shutdown-window latch", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  it("passes the live shutdown latch to the npm polling supervisor", () => {
    const setIdx = src.indexOf("shuttingDown = true");
    const guardIdx = src.indexOf("isShutdownLatched: () => shuttingDown");
    expect(setIdx, "signal handler must set shuttingDown = true").toBeGreaterThan(-1);
    expect(guardIdx, "polling supervisor must read the shutdown latch").toBeGreaterThan(-1);
  });

  it("routes an unsuppressed terminal rejection to reportFatal", () => {
    expect(src).toContain("startNpmTelegramPolling({");
    expect(src).toContain("reportFatal(error, { dataDir: config.dataDir })");
  });
});

describe("run-binary CLI exit + cold-start banner", () => {
  const SOURCE_PATH = join(__dirname, "..", "src", "run-binary.ts");
  const src = readFileSync(SOURCE_PATH, "utf-8");

  it("prints the verbatim cold-start banner before the awaited bootstrap", () => {
    const banner = "syncing training data from intervals.icu…";
    const key = "cli.startup.syncingTrainingDataFromIntervalsIcu";
    expect(say(key, { platform: "intervals.icu" })).toBe(banner);
    expect(countOccurrences(src, key)).toBe(1);
    expect(src.indexOf(key)).toBeLessThan(src.indexOf("await bootstrapReference("));
  });

  it("registers a close handler that stops the scheduler and exits 0", () => {
    expect(src).toContain('rl.on("close"');
    expect(src).toContain("reference.scheduler.stop()");
    expect(src).toContain("process.exit(0)");
  });

  it("keeps /quit and /exit routing to rl.close()", () => {
    expect(countOccurrences(src, 'input === "/quit" || input === "/exit"')).toBe(1);
    expect(src).toContain("rl.close()");
  });

  it("does not smuggle in a mid-turn abort (AbortController is the LLM-deadline work's)", () => {
    expect(src).not.toContain("AbortController");
  });
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

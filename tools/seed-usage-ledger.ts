/**
 * Seeds an ISOLATED usage-ledger.jsonl with a handful of real chat turns so the
 * `usage:baseline` summarizer can be demonstrated without a multi-day wait.
 * Turns run on the operator's configured provider (codex = subscription, no
 * marginal cost; anthropic is cost-guarded to the cheap Haiku model). The
 * provider's auth must be reachable from the isolated home — for codex, copy
 * `auth-profiles.json` into it first (see the run sequence at the bottom).
 *
 * SAFETY INVARIANT: this tool refuses to run unless CYCLING_COACH_HOME points
 * at a non-default, isolated directory. It must be impossible to write
 * synthetic turns into the operator's real ledger (the one that will hold the
 * genuine >=3-day baseline).
 *
 * CAVEAT (read before trusting numbers): these turns fire back-to-back within
 * seconds, so every turn after the first hits a warm prompt cache (~5-minute
 * provider-side TTL). Real athlete usage is spaced hours/days apart and almost
 * never reuses the cache. This sample therefore shows an inflated cache-read
 * ratio and is a TOOL SMOKE-TEST, not a faithful baseline.
 */
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import { bundledAcceptedCatalog, loadConfig, resolveConfigSecrets, CoachAgent, USAGE_LEDGER_FILE } from "@enduragent/core";
import { expandTilde } from "../packages/core/src/coach-home.js";
import { cyclingSport } from "@enduragent/sport-cycling";

// Respect the operator's configured provider (their real auth runs the turns).
// The cheap-model cost guard for the metered anthropic path is applied AFTER
// loadConfig (in main), where the provider is resolved from env AND config.yaml
// — resolving it from the LLM_PROVIDER env var alone would mis-fire for a
// yaml-configured codex operator and force a Claude model onto the codex bridge.
const HAIKU = "claude-haiku-4-5-20251001";

// --- Hard safety guard --------------------------------------------------------
const rawHome = process.env.CYCLING_COACH_HOME;
if (rawHome === undefined || rawHome.trim() === "") {
  console.error(
    "REFUSING TO RUN: CYCLING_COACH_HOME is not set.\n" +
      "This tool writes synthetic turns and must target an isolated dir.\n" +
      "Set CYCLING_COACH_HOME to a throwaway absolute path, e.g.:\n" +
      "  CYCLING_COACH_HOME=$(mktemp -d) pnpm exec tsx --env-file=.env tools/seed-usage-ledger.ts",
  );
  process.exit(1);
}
const isolatedHome = resolve(expandTilde(rawHome.trim()));
const FORBIDDEN = [
  resolve(join(homedir(), ".cycling-coach")), // tier-2 legacy default
  resolve(join(homedir(), ".enduragent", "cycling")), // tier-3 canonical default
];
if (FORBIDDEN.includes(isolatedHome)) {
  console.error(
    `REFUSING TO RUN: CYCLING_COACH_HOME resolves to a DEFAULT data dir (${isolatedHome}).\n` +
      "That is the operator's real ledger location. Point it at a throwaway dir instead.",
  );
  process.exit(1);
}

const MESSAGES = [
  "Hey coach, did 90 minutes endurance this morning, legs felt good.",
  "What should tomorrow look like if I want to keep building base?",
  "I'm a bit sore in the quads, normal?",
  "My FTP is 247W. Is that something I should retest soon?",
  "Slept badly last night, only 5 hours. Should I still ride hard today?",
  "Planning a 4-hour gravel ride Saturday — how do I fuel it?",
  "Felt flat on the bike all week. Overtraining or just life?",
  "Quick one: zone 2 power range for me?",
];

async function main(): Promise<void> {
  // loadConfig() reads CYCLING_COACH_HOME (via getCoachHome) for dataDir and
  // resolves the provider from env + config.yaml. Cost guard: only the metered
  // anthropic path — if anthropic is the resolved provider and the operator
  // pinned no model via env, force the cheap Haiku model so the smoke run stays
  // cheap. Codex/others run untouched (codex = subscription, no marginal cost).
  const loaded = loadConfig();
  if (loaded.llm.provider === "anthropic" && !process.env.LLM_MODEL) {
    loaded.llm.model = HAIKU;
    if (!process.env.LLM_FLUSH_MODEL) loaded.llm.flushModel = HAIKU;
  }
  const config = await resolveConfigSecrets(loaded);

  if (resolve(config.dataDir) !== isolatedHome) {
    console.error(
      `REFUSING TO RUN: resolved config.dataDir (${config.dataDir}) != isolated home (${isolatedHome}).\n` +
        "loadConfig did not honor CYCLING_COACH_HOME as expected — aborting to avoid touching the real ledger.\n" +
        "Pass an ABSOLUTE path (mktemp -d gives one).",
    );
    process.exit(1);
  }
  // Auth is provider-specific: the metered providers need an apiKey; codex
  // authenticates via the auth profile copied into the isolated home. Don't
  // hard-gate on apiKey — let a real auth failure surface per-turn below.
  if (config.llm.provider !== "openai-codex" && !config.llm.apiKey) {
    console.error(
      `No API key for provider '${config.llm.provider}'. Set the provider's key in .env, ` +
        "or use the codex auth profile. Aborting.",
    );
    process.exit(1);
  }
  console.log(`Provider: ${config.llm.provider}  model: ${config.llm.model}`);

  const agent = new CoachAgent(cyclingSport, config, { catalog: bundledAcceptedCatalog() });
  const chatId = "seed-smoke";

  console.log(`Seeding ${MESSAGES.length} Haiku turns into ${config.dataDir} ...`);
  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    process.stdout.write(`  [${i + 1}/${MESSAGES.length}] `);
    try {
      const reply = await agent.chat({ chatId, message: msg });
      console.log(`ok (${reply.text.length} chars)`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ledgerPath = join(config.dataDir, USAGE_LEDGER_FILE);
  console.log("\nDone. Isolated ledger written to:");
  console.log(`  ${ledgerPath}`);
  console.log(
    "\nCAVEAT: back-to-back turns share a warm prompt cache (~5-min TTL), so the\n" +
      "cache-read ratio here is inflated vs real spaced usage. Smoke-test, not a baseline.\n" +
      `Summarize it with: pnpm usage:baseline --data-dir ${config.dataDir}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Run sequence (isolates the ledger; never touches the real ~/.cycling-coach):
//
//   export CYCLING_COACH_HOME="$(mktemp -d -t cc-ledger-smoke)"
//   # codex auth lives in the data dir — copy the profile into the isolated home:
//   cp ~/.cycling-coach/auth-profiles.json "$CYCLING_COACH_HOME"/ 2>/dev/null || true
//   pnpm exec tsx --env-file=.env tools/seed-usage-ledger.ts
//   pnpm usage:baseline --data-dir "$CYCLING_COACH_HOME"
//   rm -rf "$CYCLING_COACH_HOME"   # disposable

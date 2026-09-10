import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const coachRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("coach package handoff", () => {
  it("preserves the dispatch package surface and adds serve", async () => {
    const packageJson = JSON.parse(await readFile(join(coachRoot, "package.json"), "utf8")) as {
      exports: Record<string, string>;
      scripts: Record<string, string>;
      bin: Record<string, string>;
    };
    expect(packageJson.exports).toEqual({
      "./abortable-operation": "./dist/abortable-operation.js",
      "./account-identity": "./dist/account-identity.js",
      "./runtime": "./dist/runtime.js",
      "./sync": "./dist/sync.js",
      "./backfill": "./dist/backfill.js",
      "./backfill-benchmark": "./dist/backfill-benchmark.js",
      "./capture": "./dist/capture.js",
      "./local-bundle-producer": "./dist/local-bundle-producer.js",
      "./store-runtime": "./dist/store-runtime.js",
      "./local-runner": "./dist/local-runner.js",
      "./serve": "./dist/serve.js",
      "./enduragent": "./dist/enduragent.js",
    });
    expect(packageJson.bin).toEqual({ enduragent: "./dist/enduragent.js" });
    expect(packageJson.scripts).toEqual({
      build: "tsup",
      check: "tsc --noEmit",
      test: "vitest run",
      backfill: "node dist/backfill-command.js",
      benchmark: "node dist/backfill-command.js --synthetic --conclusions-only",
      "capture-reference": "node dist/capture-command.js",
      "capture-once": "node dist/reference-capture-command.js",
      "dogfood:store": "node dist/local-bot.js",
      "season-review": "node dist/season-review-command.js",
    });
    const entries = [
      "abortable-operation",
      "account-identity",
      "runtime",
      "sync",
      "backfill",
      "backfill-benchmark",
      "backfill-command",
      "capture",
      "capture-command",
      "reference-capture-command",
      "local-bundle-producer",
      "store-runtime",
      "local-bot",
      "soak-record",
      "store-gate-command",
      "season-review-command",
      "local-runner",
      "serve",
      "enduragent",
    ];
    for (const entry of entries) {
      await expect(access(join(coachRoot, "dist", `${entry}.js`))).resolves.toBeUndefined();
      await expect(access(join(coachRoot, "dist", `${entry}.d.ts`))).resolves.toBeUndefined();
    }
    for (const subpath of Object.keys(packageJson.exports)) {
      await expect(import(`@enduragent/coach/${subpath.slice(2)}`)).resolves.toBeDefined();
    }
  });
});

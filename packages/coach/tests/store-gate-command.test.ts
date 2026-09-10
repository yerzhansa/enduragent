import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertDogfoodIsolation, runStoreGateCommand } from "../src/store-gate-command.js";
import { soakEvidence } from "./soak-record.test.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const value = await mkdtemp(join(await realpath(tmpdir()), "store-gate-"));
  roots.push(value);
  return value;
}

describe("store gate command files", () => {
  it("emits and reload-checks soak evidence with immutable final mode", async () => {
    const directory = await root(),
      raw = join(directory, "raw.json"),
      candidate = join(directory, "candidate.json");
    await writeFile(raw, `${JSON.stringify(soakEvidence())}\n`, { mode: 0o600 });
    await expect(runStoreGateCommand(["soak-emit", raw, candidate])).resolves.toBe(
      "SOAK PASS dates=7 bot=bot:12345 outage=PASS",
    );
    await chmod(candidate, 0o444);
    await expect(runStoreGateCommand(["soak-check", raw, candidate])).resolves.toBe(
      "SOAK PASS dates=7 bot=bot:12345 outage=PASS",
    );
    await expect(runStoreGateCommand(["soak-emit", raw, candidate])).rejects.toThrow();
  });

  it("creates strict 64/15/79 scratch evidence without running the real gate", async () => {
    const directory = await root(),
      raw = join(directory, "overlap.json");
    await expect(runStoreGateCommand(["overlap-scratch", raw])).resolves.toBe(
      "OVERLAP SCRATCH PASS total=79/79",
    );
    const evidence = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(raw, "utf8")),
    );
    expect(
      evidence.scratch.attempts.filter(
        (attempt: { outcome: string }) => attempt.outcome !== "limit-rejected",
      ),
    ).toHaveLength(79);
    expect(evidence.scratch.attempts).toHaveLength(80);
  });

  it("emits and reload-checks a hash-bound overlap conclusion and rejects raw mutation", async () => {
    const directory = await root(),
      scratch = join(directory, "scratch.json"),
      raw = join(directory, "raw.json"),
      candidate = join(directory, "candidate.json");
    await runStoreGateCommand(["overlap-scratch", scratch]);
    const evidence = JSON.parse(await readFile(scratch, "utf8"));
    evidence.real = {
      attempts: [],
      elapsed_ms: 1,
      completed: true,
      rate_limited: false,
      cancel_propagated: false,
    };
    await writeFile(raw, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    await expect(runStoreGateCommand(["overlap-emit", raw, candidate])).resolves.toBe(
      "OVERLAP PASS scratch=79/79 real=0/79",
    );
    await chmod(candidate, 0o444);
    await expect(runStoreGateCommand(["overlap-check", raw, candidate])).resolves.toBe(
      "OVERLAP PASS scratch=79/79 real=0/79",
    );
    evidence.real.elapsed_ms = 2;
    await writeFile(raw, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    await expect(runStoreGateCommand(["overlap-check", raw, candidate])).rejects.toThrow();
    await expect(runStoreGateCommand(["overlap-emit", raw, candidate])).rejects.toThrow();
  });

  it("uses the production sender-precedence predicate and rejects symlink env files", async () => {
    const directory = await root(),
      envPath = join(directory, "dogfood.env"),
      dataDir = join(directory, "data");
    await import("node:fs/promises").then((fs) => fs.mkdir(dataDir));
    await writeFile(
      join(dataDir, "allowed-senders.json"),
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: null,
        addedAt: {},
      }),
      { mode: 0o600 },
    );
    await writeFile(
      envPath,
      [
        "TELEGRAM_BOT_TOKEN=12345:abcdefghijklmnopqrstuv",
        "CYCLING_COACH_OPERATOR_ID=12345",
        "DOGFOOD_BOT_ATTESTED=1",
        "HOSTED_POLLER_STOPPED=1",
        "CYCLING_COACH_DM_POLICY=allowlist",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(assertDogfoodIsolation({ envPath, dataDir }).operatorId).toBe("12345");
    const link = join(directory, "dogfood-link.env");
    await symlink(envPath, link);
    expect(() => assertDogfoodIsolation({ envPath: link, dataDir })).toThrow();
  });

  it("rejects multi-sender, primary mismatch, pairing/open policy, bad attestations, and non-0600 env files", async () => {
    const make = async (
      senders: Record<string, unknown>,
      envOverrides: Record<string, string> = {},
    ) => {
      const directory = await root(),
        envPath = join(directory, "dogfood.env"),
        dataDir = join(directory, "data");
      await mkdir(dataDir);
      await writeFile(join(dataDir, "allowed-senders.json"), JSON.stringify(senders), {
        mode: 0o600,
      });
      const env = {
        TELEGRAM_BOT_TOKEN: "12345:abcdefghijklmnopqrstuv",
        CYCLING_COACH_OPERATOR_ID: "12345",
        DOGFOOD_BOT_ATTESTED: "1",
        HOSTED_POLLER_STOPPED: "1",
        CYCLING_COACH_DM_POLICY: "allowlist",
        ...envOverrides,
      };
      await writeFile(
        envPath,
        `${Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      return { envPath, dataDir };
    };
    const base = {
      version: 1,
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
      capturedAt: null,
      addedAt: {},
    };
    const multi = await make({ ...base, allowFrom: ["12345", "54321"] });
    expect(() => assertDogfoodIsolation(multi)).toThrow();
    const primary = await make({ ...base, primaryOperator: "54321" });
    expect(() => assertDogfoodIsolation(primary)).toThrow();
    const pairing = await make({ ...base, dmPolicy: "pairing" });
    expect(() => assertDogfoodIsolation(pairing)).toThrow();
    const open = await make(base, { CYCLING_COACH_DM_POLICY: "open" });
    expect(() => assertDogfoodIsolation(open)).toThrow();
    const unattested = await make(base, { HOSTED_POLLER_STOPPED: "0" });
    expect(() => assertDogfoodIsolation(unattested)).toThrow();
    const mode = await make(base);
    await chmod(mode.envPath, 0o644);
    expect(() => assertDogfoodIsolation(mode)).toThrow();
  });

  it("binds conclusions to the current validation head", () => {
    expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
});

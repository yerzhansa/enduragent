import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicWriter from "../src/io/atomic-write-file-sync.js";
import {
  DESKTOP_OAUTH_OWNERSHIP_FILE,
  migrateDesktopOAuthProfiles,
  loadStoredProfileSnapshot,
} from "../src/auth/profile-store.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("desktop OAuth migration transaction", () => {
  it("converges after legacy removal succeeds but ownership marking fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-oauth-migration-"));
    directories.push(directory);
    const path = join(directory, "auth-profiles.json");
    const profile = {
      type: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: 1,
    };
    writeFileSync(path, JSON.stringify({ "openai-codex": profile, other: { preserve: true } }));
    const source = loadStoredProfileSnapshot(path, "openai-codex");
    const write = atomicWriter.atomicWriteFileSync;
    vi.spyOn(atomicWriter, "atomicWriteFileSync").mockImplementation((target, content) => {
      if (target.endsWith(DESKTOP_OAUTH_OWNERSHIP_FILE))
        throw new Error("synthetic-marker-failure");
      write(target, content);
    });
    let encryptedVerified = false;
    await expect(
      migrateDesktopOAuthProfiles(path, ["openai-codex"], async (legacy) => {
        expect(legacy["openai-codex"]).toEqual(source);
        encryptedVerified = true;
      }),
    ).rejects.toThrow("synthetic-marker-failure");
    expect(encryptedVerified).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: { preserve: true } });
    vi.restoreAllMocks();
    await migrateDesktopOAuthProfiles(path, ["openai-codex"], async (legacy, owned) => {
      expect(legacy).toEqual({});
      expect(owned).toBe(false);
      expect(encryptedVerified).toBe(true);
    });
    expect(() => loadStoredProfileSnapshot(path, "openai-codex")).toThrow("separate CLI home");
  });

  it("refuses unreadable ownership markers without activating legacy access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-oauth-marker-"));
    directories.push(directory);
    const path = join(directory, "auth-profiles.json");
    mkdirSync(join(directory, DESKTOP_OAUTH_OWNERSHIP_FILE));
    const persist = vi.fn(async () => {});
    await expect(migrateDesktopOAuthProfiles(path, ["openai-codex"], persist)).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
    expect(() => loadStoredProfileSnapshot(path, "openai-codex")).toThrow("separate CLI home");
  });
});

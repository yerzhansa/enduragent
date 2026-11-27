import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAcceptanceKeychainTransport,
  resolveAcceptanceCredentialBackend,
} from "../src/main/acceptance-credential-backend.js";

const appPath = "/Applications/Enduragent Telegram Acceptance.app/Contents/Resources/app.asar";
const userDataPath = "/tmp/acceptance-user-data";
const acceptanceManifest = JSON.stringify({
  name: "enduragent-desktop-telegram-acceptance",
  productName: "Enduragent Telegram Acceptance",
  enduragentDesktopTelegramAcceptance: true,
});
const temporaryRoots: string[] = [];

function eligibility(
  overrides: Partial<Parameters<typeof resolveAcceptanceCredentialBackend>[0]> = {},
) {
  return resolveAcceptanceCredentialBackend({
    isPackaged: true,
    hidden: true,
    backend: "file",
    appName: "Enduragent Telegram Acceptance",
    appPath,
    userDataPath,
    disposableContext: true,
    readPackageJson: () => acceptanceManifest,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("acceptance credential backend eligibility", () => {
  it("allows an explicitly requested visible development memory backend", () => {
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    const selected = eligibility({
      isPackaged: false,
      hidden: false,
      backend: "memory",
      readPackageJson,
    });
    expect(selected?.kind).toBe("memory");
    if (selected?.kind !== "memory") throw new Error("memory backend was not selected");
    expect(selected.key).toHaveLength(32);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it("rejects a persistent development memory backend", () => {
    expect(
      eligibility({
        isPackaged: false,
        hidden: false,
        backend: "memory",
        disposableContext: false,
      }),
    ).toBeUndefined();
  });

  it("allows the marked packaged Telegram acceptance app", () => {
    const readPackageJson = vi.fn(() => acceptanceManifest);
    expect(eligibility({ readPackageJson })).toEqual({
      kind: "file",
      keyPath: join(userDataPath, ".enduragent-acceptance-key"),
    });
    expect(readPackageJson).toHaveBeenCalledWith(join(appPath, "package.json"));
  });

  it.each([
    ["visible", { hidden: false }],
    ["unrequested", { backend: undefined }],
    ["memory-backed package", { backend: "memory" }],
    ["non-disposable", { disposableContext: false }],
    ["wrong app name", { appName: "Enduragent" }],
  ])("rejects a %s runtime before inspecting package metadata", (_case, overrides) => {
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(eligibility({ ...overrides, readPackageJson })).toBeUndefined();
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary package", JSON.stringify({ name: "@enduragent/desktop" })],
    [
      "wrong package name",
      JSON.stringify({
        name: "@enduragent/desktop",
        productName: "Enduragent Telegram Acceptance",
        enduragentDesktopTelegramAcceptance: true,
      }),
    ],
    [
      "wrong product name",
      JSON.stringify({
        name: "enduragent-desktop-telegram-acceptance",
        productName: "Enduragent",
        enduragentDesktopTelegramAcceptance: true,
      }),
    ],
    [
      "false marker",
      JSON.stringify({
        name: "enduragent-desktop-telegram-acceptance",
        productName: "Enduragent Telegram Acceptance",
        enduragentDesktopTelegramAcceptance: false,
      }),
    ],
    ["malformed metadata", "not-json"],
    ["oversized metadata", " ".repeat(64 * 1024 + 1)],
  ])("rejects %s", (_case, raw) => {
    expect(eligibility({ readPackageJson: () => raw })).toBeUndefined();
  });

  it("fails closed when package metadata cannot be read", () => {
    expect(
      eligibility({
        readPackageJson: () => {
          throw new Error("synthetic read failure");
        },
      }),
    ).toBeUndefined();
  });
});

describe("acceptance Keychain lock marker", () => {
  const lockMarkerPath = "/tmp/acceptance-keychain-locked";

  it("is carried only by a backend the acceptance gates allow", () => {
    expect(eligibility({ lockMarkerPath })).toMatchObject({ kind: "file", lockMarkerPath });
    expect(
      eligibility({ isPackaged: false, hidden: false, backend: "memory", lockMarkerPath }),
    ).toMatchObject({ kind: "memory", lockMarkerPath });
    expect(eligibility({ hidden: false, lockMarkerPath })).toBeUndefined();
    expect(
      eligibility({
        isPackaged: false,
        backend: "memory",
        disposableContext: false,
        lockMarkerPath,
      }),
    ).toBeUndefined();
    expect(eligibility({ lockMarkerPath: "relative/locked" })).not.toHaveProperty("lockMarkerPath");
  });

  it("answers like a locked Keychain while the marker exists, and normally once it is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-lock-"));
    temporaryRoots.push(root);
    const marker = join(root, "locked");
    await writeFile(marker, "");
    const selected = eligibility({
      isPackaged: false,
      backend: "memory",
      lockMarkerPath: marker,
    });
    if (selected?.kind !== "memory") throw new Error("memory backend was not selected");
    const transport = createAcceptanceKeychainTransport(selected);
    const service = "acceptance";

    await expect(transport.send({ op: "probe", service })).resolves.toMatchObject({ ok: true });
    await expect(transport.send({ op: "retry-created-key-rollback", service })).resolves.toEqual({
      ok: true,
      op: "retry-created-key-rollback",
    });
    await expect(transport.send({ op: "read-key", service })).resolves.toEqual({
      ok: false,
      code: "keychain-locked",
    });
    await expect(transport.send({ op: "create-key", service })).resolves.toEqual({
      ok: false,
      code: "keychain-locked",
      creationRollbackPending: false,
    });
    await expect(transport.send({ op: "delete-key", service })).resolves.toEqual({
      ok: false,
      code: "keychain-locked",
    });

    await rm(marker);
    await expect(transport.send({ op: "read-key", service })).resolves.toEqual({
      ok: true,
      op: "read-key",
      key: selected.key,
    });
  });
});

describe("file-backed acceptance key transport", () => {
  it("persists across processes, deletes durably, and rotates after deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-key-"));
    temporaryRoots.push(root);
    const backend = { kind: "file" as const, keyPath: join(root, "key") };
    const first = createAcceptanceKeychainTransport(backend);
    const created = await first.send({ op: "create-key", service: "acceptance" });
    expect(created.ok).toBe(true);
    if (!created.ok || created.op !== "create-key") throw new Error("key was not created");
    const original = Buffer.from(created.key);

    const second = createAcceptanceKeychainTransport(backend);
    await expect(second.send({ op: "read-key", service: "acceptance" })).resolves.toEqual({
      ok: true,
      op: "read-key",
      key: original,
    });
    await expect(second.send({ op: "delete-key", service: "acceptance" })).resolves.toEqual({
      ok: true,
      op: "delete-key",
      deleted: true,
    });

    const third = createAcceptanceKeychainTransport(backend);
    await expect(third.send({ op: "read-key", service: "acceptance" })).resolves.toEqual({
      ok: false,
      code: "item-not-found",
    });
    const rotated = await third.send({ op: "create-key", service: "acceptance" });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok || rotated.op !== "create-key") throw new Error("key was not rotated");
    expect(rotated.key.equals(original)).toBe(false);
    original.fill(0);
  });
});

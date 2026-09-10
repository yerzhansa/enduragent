import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpVaultAmbiguousError,
  SecretTooLargeError,
  opItemCreate,
  opItemDelete,
  opItemGet,
  opItemUpdate,
  opSecretRef,
  opVaultList,
  redactTemplateForLog,
} from "../../../src/secrets/backends/op.js";
import { isSecretRef } from "../../../src/secrets/types.js";

const tempDirs: string[] = [];

async function makeOpStub(script: string): Promise<{ opPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "op-stub-"));
  tempDirs.push(dir);
  const opPath = join(dir, "op");
  const wrapped = `#!/bin/sh
STUB_DIR='${dir}'
printf '%s\\n' "$@" > "$STUB_DIR/argv"
cat > "$STUB_DIR/stdin"
${script}
`;
  await writeFile(opPath, wrapped, { mode: 0o755 });
  return { opPath, dir };
}

async function readArgv(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, "argv"), "utf8");
  return raw.split("\n").slice(0, -1); // trailing "" after final \n
}

async function readStdin(dir: string): Promise<string> {
  return readFile(join(dir, "stdin"), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("opItemGet", () => {
  it("returns {exists:false} when stderr mentions 'isn't an item'", async () => {
    const { opPath } = await makeOpStub(`
printf "[ERROR] \\"foo\\" isn't an item. Specify the item with its UUID, name, or domain.\\n" >&2
exit 1
`);
    const result = await opItemGet(opPath, "foo");
    expect(result).toEqual({ exists: false });
  });

  it("parses vault.name from stdout on exit 0", async () => {
    const { opPath } = await makeOpStub(`
printf '{"id":"abc","title":"foo","vault":{"id":"v1","name":"Personal"},"fields":[]}'
`);
    const result = await opItemGet(opPath, "foo");
    expect(result).toEqual({ exists: true, vaultName: "Personal" });
  });

  it("passes --vault when provided", async () => {
    const { opPath, dir } = await makeOpStub(`
printf '{"vault":{"name":"Test"},"fields":[]}'
`);
    await opItemGet(opPath, "foo", "Test");
    const argv = await readArgv(dir);
    expect(argv).toEqual(["item", "get", "foo", "--vault", "Test", "--format=json"]);
  });

  it("throws on non-zero exit with unrecognized stderr", async () => {
    const { opPath } = await makeOpStub(`
printf "some auth error\\n" >&2
exit 1
`);
    await expect(opItemGet(opPath, "foo")).rejects.toThrow(/some auth error/);
  });
});

describe("opItemCreate", () => {
  const fixtureStdout = JSON.stringify({
    id: "abc",
    title: "foo",
    vault: { id: "v1", name: "Personal" },
    fields: [
      {
        id: "credential",
        type: "CONCEALED",
        value: "whatever",
        reference: "op://Personal/foo/credential",
      },
    ],
  });

  it("spawns 'item create - --format=json' exactly once and parses vault from stdout (D18)", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const result = await opItemCreate(opPath, "foo", "sk-value", "Personal");
    expect(result).toEqual({ vaultName: "Personal" });
    const argv = await readArgv(dir);
    expect(argv).toEqual(["item", "create", "-", "--format=json", "--vault", "Personal"]);
  });

  it("passes --vault <name> in argv when vaultName given", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    await opItemCreate(opPath, "foo", "sk-value", "Personal");
    const argv = await readArgv(dir);
    expect(argv).toContain("--vault");
    expect(argv).toContain("Personal");
  });

  it("omits --vault when no vaultName given", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    await opItemCreate(opPath, "foo", "sk-value");
    const argv = await readArgv(dir);
    expect(argv).not.toContain("--vault");
  });

  it("throws OpVaultAmbiguousError when stderr matches multi-vault regex", async () => {
    const { opPath } = await makeOpStub(`
printf "[ERROR] more than one vault, specify --vault\\n" >&2
exit 1
`);
    await expect(opItemCreate(opPath, "foo", "sk-value")).rejects.toBeInstanceOf(
      OpVaultAmbiguousError,
    );
  });

  it("throws generic error with stderr tail on non-vault error", async () => {
    const { opPath } = await makeOpStub(`
printf "authorization timeout\\n" >&2
exit 1
`);
    await expect(opItemCreate(opPath, "foo", "sk-value", "Personal")).rejects.toThrow(
      /authorization timeout/,
    );
  });

  it("round-trips a value with quotes through stdin byte-for-byte", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const value = 'sk-"with-quotes"';
    await opItemCreate(opPath, "foo", value, "Personal");
    const stdin = await readStdin(dir);
    const parsed = JSON.parse(stdin) as {
      fields: Array<{ id: string; value: string }>;
    };
    expect(parsed.fields[0].value).toBe(value);
  });

  it("round-trips a value with backslash through stdin byte-for-byte", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const value = "sk-\\with-backslash";
    await opItemCreate(opPath, "foo", value, "Personal");
    const stdin = await readStdin(dir);
    const parsed = JSON.parse(stdin) as {
      fields: Array<{ id: string; value: string }>;
    };
    expect(parsed.fields[0].value).toBe(value);
  });

  it("round-trips a value with newlines and tabs through stdin byte-for-byte", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const value = "sk-\nwith\tcontrol";
    await opItemCreate(opPath, "foo", value, "Personal");
    const stdin = await readStdin(dir);
    const parsed = JSON.parse(stdin) as {
      fields: Array<{ id: string; value: string }>;
    };
    expect(parsed.fields[0].value).toBe(value);
  });

  it("round-trips a UTF-8 multi-byte value through stdin byte-for-byte", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const value = "sk-тест-🚴";
    await opItemCreate(opPath, "foo", value, "Personal");
    const stdin = await readStdin(dir);
    const parsed = JSON.parse(stdin) as {
      fields: Array<{ id: string; value: string }>;
    };
    expect(parsed.fields[0].value).toBe(value);
  });

  it("rejects 65_537-byte value with SecretTooLargeError BEFORE any spawn", async () => {
    const { opPath, dir } = await makeOpStub(
      `printf 'STUB_WAS_CALLED' > "$STUB_DIR/called"
printf '%s' '${fixtureStdout}'`,
    );
    const oversize = "x".repeat(65_537);
    await expect(opItemCreate(opPath, "foo", oversize, "Personal")).rejects.toBeInstanceOf(
      SecretTooLargeError,
    );
    expect(await exists(join(dir, "called"))).toBe(false);
  });

  it("accepts exactly 65_536-byte value (size cap boundary)", async () => {
    const { opPath } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const boundary = "x".repeat(65_536);
    const result = await opItemCreate(opPath, "foo", boundary, "Personal");
    expect(result).toEqual({ vaultName: "Personal" });
  });

  it("redacts the value when build-error message echoes the template (no-log-leak)", async () => {
    const { opPath } = await makeOpStub(`
cat /dev/null  # stdin already consumed by wrapper
printf "something went wrong\\n" >&2
exit 1
`);
    const secret = "SECRET_VALUE_SHOULD_NOT_LEAK";
    const err = await opItemCreate(opPath, "foo", secret, "Personal").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).toContain("<redacted>");
  });

  it("never writes the secret value into argv (argv leak guard)", async () => {
    const { opPath, dir } = await makeOpStub(`printf '%s' '${fixtureStdout}'`);
    const secret = "SECRET_TOKEN_VALUE_123";
    await opItemCreate(opPath, "foo", secret, "Personal");
    const argv = await readArgv(dir);
    for (const arg of argv) {
      expect(arg).not.toContain(secret);
    }
    const stdin = await readStdin(dir);
    expect(stdin).toContain(secret);
  });
});

describe("opItemUpdate", () => {
  it("runs get → modify → edit and pipes full JSON with new value to stdin", async () => {
    const existingItem = {
      id: "abc",
      title: "foo",
      vault: { id: "v1", name: "Personal" },
      fields: [
        { id: "notesPlain", type: "STRING", purpose: "NOTES", value: "" },
        {
          id: "credential",
          type: "CONCEALED",
          value: "old-value",
          reference: "op://Personal/foo/credential",
        },
      ],
    };
    const { opPath, dir } = await makeOpStub(`
case "$2" in
  get) printf '%s' '${JSON.stringify(existingItem)}' ;;
  edit) : ;;
esac
`);
    await opItemUpdate(opPath, "foo", "new-value", "Personal");
    const argv = await readArgv(dir);
    expect(argv).toEqual(["item", "edit", "foo", "--vault", "Personal", "-"]);
    const stdin = await readStdin(dir);
    const parsed = JSON.parse(stdin) as {
      fields: Array<{ id: string; value: string }>;
    };
    const cred = parsed.fields.find((f) => f.id === "credential");
    expect(cred?.value).toBe("new-value");
    const notes = parsed.fields.find((f) => f.id === "notesPlain");
    expect(notes).toBeDefined();
  });

  it("rejects oversized value with SecretTooLargeError BEFORE any spawn", async () => {
    const { opPath, dir } = await makeOpStub(`printf 'STUB_WAS_CALLED' > "$STUB_DIR/called"`);
    const oversize = "x".repeat(65_537);
    await expect(opItemUpdate(opPath, "foo", oversize, "Personal")).rejects.toBeInstanceOf(
      SecretTooLargeError,
    );
    expect(await exists(join(dir, "called"))).toBe(false);
  });

  it("throws when get returns an item without a credential field", async () => {
    const itemWithoutCred = {
      id: "abc",
      title: "foo",
      vault: { name: "Personal" },
      fields: [{ id: "notesPlain", type: "STRING", value: "" }],
    };
    const { opPath } = await makeOpStub(`printf '%s' '${JSON.stringify(itemWithoutCred)}'`);
    await expect(opItemUpdate(opPath, "foo", "new-value", "Personal")).rejects.toThrow(
      /no 'credential' field/,
    );
  });
});

describe("opVaultList", () => {
  it("parses the JSON array into {id, name} entries", async () => {
    const { opPath } = await makeOpStub(
      `printf '[{"id":"v1","name":"Personal","content_version":1},{"id":"v2","name":"Test","content_version":2}]'`,
    );
    const result = await opVaultList(opPath);
    expect(result).toEqual([
      { id: "v1", name: "Personal" },
      { id: "v2", name: "Test" },
    ]);
  });

  it("throws on non-zero exit", async () => {
    const { opPath } = await makeOpStub(`
printf "vault list failed\\n" >&2
exit 1
`);
    await expect(opVaultList(opPath)).rejects.toThrow(/vault list failed/);
  });
});

describe("opItemDelete", () => {
  it("returns {deleted:true} on exit 0", async () => {
    const { opPath, dir } = await makeOpStub(``);
    const result = await opItemDelete(opPath, "foo", "Personal");
    expect(result).toEqual({ deleted: true });
    const argv = await readArgv(dir);
    expect(argv).toEqual(["item", "delete", "foo", "--vault", "Personal"]);
  });

  it("returns {deleted:false} when stderr mentions 'isn't an item' (C11)", async () => {
    const { opPath } = await makeOpStub(`
printf "[ERROR] \\"foo\\" isn't an item. Specify the item with its UUID, name, or domain.\\n" >&2
exit 1
`);
    const result = await opItemDelete(opPath, "foo", "Personal");
    expect(result).toEqual({ deleted: false });
  });

  it("throws on other non-zero exits (e.g., auth failure)", async () => {
    const { opPath } = await makeOpStub(`
printf "authorization timeout\\n" >&2
exit 1
`);
    await expect(opItemDelete(opPath, "foo", "Personal")).rejects.toThrow(/authorization timeout/);
  });
});

describe("opSecretRef", () => {
  it("produces a valid SecretRef with the supplied vault name interpolated into the op:// path", async () => {
    const ref = opSecretRef("cycling-coach · anthropic_api_key", "/usr/local/bin/op", "Personal");
    expect(isSecretRef(ref)).toBe(true);
    expect(ref).toEqual({
      source: "exec",
      command: "/usr/local/bin/op",
      args: ["read", "op://Personal/cycling-coach · anthropic_api_key/credential"],
    });
  });
});

describe("redactTemplateForLog", () => {
  it("replaces fields[].value with '<redacted>' and preserves structure", () => {
    const template = JSON.stringify({
      title: "foo",
      category: "API_CREDENTIAL",
      fields: [{ id: "credential", type: "CONCEALED", label: "credential", value: "sk-secret" }],
    });
    const redacted = redactTemplateForLog(template);
    expect(redacted).not.toContain("sk-secret");
    expect(redacted).toContain("<redacted>");
    const parsed = JSON.parse(redacted) as { fields: Array<{ value: string }> };
    expect(parsed.fields[0].value).toBe("<redacted>");
  });

  it("returns '<redacted>' when input is not valid JSON", () => {
    expect(redactTemplateForLog("not json at all")).toBe("<redacted>");
  });
});

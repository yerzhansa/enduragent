import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffWindowsPeInventory,
  enumeratePortableExecutables,
  isPortableExecutable,
  readWindowsPeInventory,
  type WindowsPeInventory,
} from "../scripts/windows-pe-inventory.mjs";

const inventoryPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../build/windows-pe-inventory.json",
);
const temporaryRoots: string[] = [];

function portableExecutable() {
  const bytes = Buffer.alloc(68);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "binary");
  return bytes;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows PE inventory", () => {
  it("recognizes bounded PE headers", () => {
    expect(isPortableExecutable(portableExecutable())).toBe(true);
    expect(isPortableExecutable(Buffer.from("MZ text"))).toBe(false);
    expect(isPortableExecutable(Buffer.alloc(68))).toBe(false);
  });

  it("enumerates PEs recursively and reports inventory differences and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-pe-inventory-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "nested"));
    await Promise.all([
      writeFile(join(root, "Declared.exe"), portableExecutable()),
      writeFile(join(root, "text.dll"), "not a portable executable"),
      writeFile(join(root, "nested", "Extra.dll"), portableExecutable()),
    ]);
    await symlink(join(root, "Declared.exe"), join(root, "linked.exe"));
    expect(await enumeratePortableExecutables(root)).toEqual([
      "Declared.exe",
      "nested/Extra.dll",
    ]);
    const inventory: WindowsPeInventory = {
      schema: "windows-pe-inventory/1",
      signing: { tool: "electron-builder", version: "26.15.3", option: "win.signExts" },
      required: [
        { path: "Declared.exe", kind: "application" },
        { path: "Missing.dll", kind: "runtime-library" },
        { path: "Uninstall Enduragent.exe", kind: "uninstaller", location: "installer-payload" },
        {
          path: "Enduragent-${version}-x64.exe",
          kind: "installer",
          location: "artifact",
        },
      ],
      thirdPartyExceptions: [],
    };
    const result = await diffWindowsPeInventory({ unpackedRoot: root, inventory, version: "1.2.3" });
    expect(result).toMatchObject({
      ok: false,
      missing: ["Missing.dll"],
      undeclared: ["nested/Extra.dll"],
      symlinks: ["linked.exe"],
      expected: ["Declared.exe", "Missing.dll"],
      actual: ["Declared.exe", "nested/Extra.dll"],
      notInspected: ["Enduragent-1.2.3-x64.exe", "Uninstall Enduragent.exe"],
    });
  });

  it("strictly parses the committed inventory and freezes the complete PE set", () => {
    const inventory = readWindowsPeInventory(inventoryPath);
    expect(inventory.signing).toEqual({
      tool: "electron-builder",
      version: "26.15.3",
      option: "win.signExts",
    });
    expect(inventory.required).toEqual([
      { path: "Enduragent.exe", kind: "application" },
      { path: "d3dcompiler_47.dll", kind: "runtime-library" },
      { path: "dxcompiler.dll", kind: "runtime-library" },
      { path: "dxil.dll", kind: "runtime-library" },
      { path: "ffmpeg.dll", kind: "runtime-library" },
      { path: "vk_swiftshader.dll", kind: "runtime-library" },
      { path: "vulkan-1.dll", kind: "runtime-library" },
      {
        path: "Uninstall Enduragent.exe",
        kind: "uninstaller",
        location: "installer-payload",
      },
      {
        path: "Enduragent-${version}-x64.exe",
        kind: "installer",
        location: "artifact",
      },
    ]);
    expect(inventory.thirdPartyExceptions).toEqual([]);
    expect(Object.isFrozen(inventory.required)).toBe(true);
  });

  it("rejects incomplete third-party exception entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-pe-invalid-inventory-"));
    temporaryRoots.push(root);
    const path = join(root, "inventory.json");
    await writeFile(
      path,
      JSON.stringify({
        schema: "windows-pe-inventory/1",
        signing: { tool: "electron-builder", version: "26.15.3", option: "win.signExts" },
        required: [{ path: "Enduragent.exe", kind: "application" }],
        thirdPartyExceptions: [{ path: "vendor.dll" }],
      }),
    );
    expect(() => readWindowsPeInventory(path)).toThrow("Windows PE inventory is invalid");
  });
});

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DESKTOP_APP_USER_MODEL_ID } from "../src/main/constants.js";

interface WindowsIconGeneratorModule {
  readonly APPLICATION_ICON_SIZES: readonly number[];
  readonly TRAY_ICON_SIZES: readonly number[];
  readonly PIXEL_GRID_ICON_SIZES: readonly number[];
  readonly createPngIco: (frames: Array<{ readonly size: number; readonly png: Buffer }>) => Buffer;
  readonly generateWindowsIcons: (input: {
    readonly applicationPath: string;
    readonly trayPath: string;
    readonly sipsPath: string;
  }) => Promise<unknown>;
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorModuleUrl = new URL("../scripts/generate-windows-icons.mjs", import.meta.url).href;
const {
  APPLICATION_ICON_SIZES,
  TRAY_ICON_SIZES,
  PIXEL_GRID_ICON_SIZES,
  createPngIco,
  generateWindowsIcons,
} = (await import(generatorModuleUrl)) as WindowsIconGeneratorModule;
const icoSignature = Buffer.from([0, 0, 1, 0]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngFrame(size: number): Buffer {
  const frame = Buffer.alloc(24);
  pngSignature.copy(frame);
  frame.write("IHDR", 12, "ascii");
  frame.writeUInt32BE(size, 16);
  frame.writeUInt32BE(size, 20);
  return frame;
}

function icoFrames(ico: Buffer): Map<number, Buffer> {
  expect(ico.subarray(0, icoSignature.length)).toEqual(icoSignature);
  const frames = new Map<number, Buffer>();
  for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
    const entryOffset = 6 + index * 16;
    const width = ico.readUInt8(entryOffset);
    const length = ico.readUInt32LE(entryOffset + 8);
    const imageOffset = ico.readUInt32LE(entryOffset + 12);
    frames.set(width === 0 ? 256 : width, ico.subarray(imageOffset, imageOffset + length));
  }
  return frames;
}

function pixelGridSource(size: number): Promise<Buffer> {
  return readFile(join(desktopRoot, "resources", `app-icon-windows-${size}.png`));
}

const fakeSips = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const [, , , size, , , , target] = process.argv;
const frame = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(frame);
frame.write("IHDR", 12, "ascii");
frame.writeUInt32BE(Number(size), 16);
frame.writeUInt32BE(Number(size), 20);
writeFileSync(target, frame);
`;

describe("Windows icon generation", () => {
  it("encodes the declared PNG frames as an ICO directory and payload", () => {
    const smallFrame = pngFrame(16);
    const largeFrame = pngFrame(256);
    const ico = createPngIco([
      { size: 16, png: smallFrame },
      { size: 256, png: largeFrame },
    ]);

    expect(APPLICATION_ICON_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(TRAY_ICON_SIZES).toEqual([16, 20, 24, 32, 40, 48]);
    expect(ico.subarray(0, 4)).toEqual(icoSignature);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(10)).toBe(1);
    expect(ico.readUInt16LE(12)).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(smallFrame.length);
    expect(ico.readUInt32LE(18)).toBe(38);
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt8(23)).toBe(0);
    expect(ico.readUInt32LE(30)).toBe(largeFrame.length);
    expect(ico.readUInt32LE(34)).toBe(38 + smallFrame.length);
    expect(ico.subarray(38, 38 + smallFrame.length)).toEqual(smallFrame);
    expect(ico.subarray(38 + smallFrame.length)).toEqual(largeFrame);
  });

  it("takes the 16, 20 and 24 px frames from the pixel-grid sources and resamples the rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-windows-icons-test-"));
    try {
      const sipsPath = join(directory, "sips");
      await writeFile(sipsPath, fakeSips);
      await chmod(sipsPath, 0o755);
      const applicationPath = join(directory, "app-icon.ico");
      const trayPath = join(directory, "tray.ico");

      await generateWindowsIcons({ applicationPath, trayPath, sipsPath });

      expect(PIXEL_GRID_ICON_SIZES).toEqual([16, 20, 24]);
      for (const [path, sizes] of [
        [applicationPath, APPLICATION_ICON_SIZES],
        [trayPath, TRAY_ICON_SIZES],
      ] as const) {
        const frames = icoFrames(await readFile(path));
        expect([...frames.keys()]).toEqual(sizes);
        for (const size of sizes) {
          expect(frames.get(size)).toEqual(
            PIXEL_GRID_ICON_SIZES.includes(size) ? await pixelGridSource(size) : pngFrame(size),
          );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the Windows builder wired to the committed ICO resources", async () => {
    const builder = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"));

    expect(builder.appId).toBe(DESKTOP_APP_USER_MODEL_ID);
    expect(builder.win).toEqual({
      icon: "resources/app-icon.ico",
      signExecutable: false,
      requestedExecutionLevel: "asInvoker",
      files: ["resources/tray.ico"],
      target: [{ target: "nsis", arch: ["x64"] }],
    });
  });

  it("keeps the runtime login value names aligned with the uninstall hook", async () => {
    const installer = await readFile(join(desktopRoot, "build", "installer.nsh"), "utf8");

    expect(installer).toContain(
      `DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${DESKTOP_APP_USER_MODEL_ID}"`,
    );
    expect(installer).toContain(
      `DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${DESKTOP_APP_USER_MODEL_ID}"`,
    );
  });

  it.each([
    ["app-icon.ico", APPLICATION_ICON_SIZES],
    ["tray.ico", TRAY_ICON_SIZES],
  ] as const)(
    "commits %s with every frame and the pixel-grid small frames",
    async (name, sizes) => {
      const frames = icoFrames(await readFile(join(desktopRoot, "resources", name)));

      expect([...frames.keys()]).toEqual(sizes);
      for (const size of PIXEL_GRID_ICON_SIZES.filter((candidate) => sizes.includes(candidate))) {
        expect(frames.get(size)).toEqual(await pixelGridSource(size));
      }
    },
  );
});

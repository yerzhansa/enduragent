import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const resourcesDirectory = join(desktopRoot, "resources");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const APPLICATION_ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const TRAY_ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48]);
export const PIXEL_GRID_ICON_SIZES = Object.freeze([16, 20, 24]);

function readPngSize(png) {
  if (
    png.length < 24 ||
    !png.subarray(0, pngSignature.length).equals(pngSignature) ||
    png.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new TypeError("invalid PNG frame");
  }
  return Object.freeze({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
}

export function createPngIco(frames) {
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 65_535) {
    throw new TypeError("invalid ICO frame collection");
  }
  const sizes = new Set();
  let imageOffset = 6 + frames.length * 16;
  const normalizedFrames = frames.map((frame) => {
    if (!Buffer.isBuffer(frame.png)) throw new TypeError("invalid ICO frame data");
    const dimensions = readPngSize(frame.png);
    if (
      !Number.isInteger(frame.size) ||
      frame.size < 1 ||
      frame.size > 256 ||
      dimensions.width !== frame.size ||
      dimensions.height !== frame.size ||
      sizes.has(frame.size)
    ) {
      throw new TypeError("invalid ICO frame size");
    }
    sizes.add(frame.size);
    const normalized = Object.freeze({
      size: frame.size,
      png: frame.png,
      imageOffset,
    });
    imageOffset += frame.png.length;
    return normalized;
  });
  const ico = Buffer.alloc(imageOffset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(normalizedFrames.length, 4);
  for (const [index, frame] of normalizedFrames.entries()) {
    const entryOffset = 6 + index * 16;
    ico.writeUInt8(frame.size === 256 ? 0 : frame.size, entryOffset);
    ico.writeUInt8(frame.size === 256 ? 0 : frame.size, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(frame.png.length, entryOffset + 8);
    ico.writeUInt32LE(frame.imageOffset, entryOffset + 12);
    frame.png.copy(ico, frame.imageOffset);
  }
  return ico;
}

async function resizePng(sourcePath, targetPath, size, sipsPath) {
  await execFileAsync(sipsPath, [
    "--resampleHeightWidth",
    String(size),
    String(size),
    sourcePath,
    "--out",
    targetPath,
  ]);
  const png = await readFile(targetPath);
  const dimensions = readPngSize(png);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error("generated PNG frame has unexpected dimensions");
  }
  return png;
}

async function writeAtomically(path, bytes) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, path);
}

export async function generateWindowsIcons(input = {}) {
  const sourcePath = input.sourcePath ?? join(resourcesDirectory, "app-icon-windows.png");
  const applicationPath = input.applicationPath ?? join(resourcesDirectory, "app-icon.ico");
  const trayPath = input.trayPath ?? join(resourcesDirectory, "tray.ico");
  const sipsPath = input.sipsPath ?? "/usr/bin/sips";
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "enduragent-windows-icons-"));
  try {
    const source = await readFile(sourcePath);
    const sourceDimensions = readPngSize(source);
    if (sourceDimensions.width !== sourceDimensions.height) {
      throw new TypeError("source icon must be square");
    }
    const sizes = [...new Set([...APPLICATION_ICON_SIZES, ...TRAY_ICON_SIZES])].sort(
      (left, right) => left - right,
    );
    const frames = new Map();
    for (const size of sizes) {
      frames.set(
        size,
        PIXEL_GRID_ICON_SIZES.includes(size)
          ? await readFile(join(resourcesDirectory, `app-icon-windows-${size}.png`))
          : await resizePng(sourcePath, join(temporaryDirectory, `${size}.png`), size, sipsPath),
      );
    }
    const applicationIco = createPngIco(
      APPLICATION_ICON_SIZES.map((size) => ({ size, png: frames.get(size) })),
    );
    const trayIco = createPngIco(TRAY_ICON_SIZES.map((size) => ({ size, png: frames.get(size) })));
    await writeAtomically(applicationPath, applicationIco);
    await writeAtomically(trayPath, trayIco);
    return Object.freeze({ applicationPath, trayPath });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  const result = await generateWindowsIcons();
  process.stdout.write(`windows application icon: ${result.applicationPath}\n`);
  process.stdout.write(`windows tray icon: ${result.trayPath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("windows icon generation failed\n");
    process.exitCode = 1;
  }
}

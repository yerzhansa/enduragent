import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const WINDOWS_STORE_ASSET_DIRECTORY = "build/appx";

// electron-builder maps these names into the AppX manifest; the icon sits inside a transparent canvas.
export const WINDOWS_STORE_ASSETS = Object.freeze([
  Object.freeze({ name: "StoreLogo.png", width: 50, height: 50, iconSize: 50 }),
  Object.freeze({ name: "Square44x44Logo.png", width: 44, height: 44, iconSize: 44 }),
  Object.freeze({ name: "Square150x150Logo.png", width: 150, height: 150, iconSize: 100 }),
  Object.freeze({ name: "Wide310x150Logo.png", width: 310, height: 150, iconSize: 100 }),
]);

export function readPngSize(png) {
  if (
    !Buffer.isBuffer(png) ||
    png.length < 24 ||
    !png.subarray(0, pngSignature.length).equals(pngSignature) ||
    png.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new TypeError("invalid PNG image");
  }
  return Object.freeze({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
}

export function windowsStoreAssetSvg(asset, sourcePng) {
  const x = (asset.width - asset.iconSize) / 2;
  const y = (asset.height - asset.iconSize) / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}" viewBox="0 0 ${asset.width} ${asset.height}">`,
    `<image x="${x}" y="${y}" width="${asset.iconSize}" height="${asset.iconSize}" href="data:image/png;base64,${sourcePng.toString("base64")}"/>`,
    "</svg>",
  ].join("");
}

async function writeAtomically(path, bytes) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, path);
}

export async function generateWindowsStoreAssets(input = {}) {
  const sourcePath = input.sourcePath ?? join(desktopRoot, "resources", "app-icon-windows.png");
  const outputDirectory = input.outputDirectory ?? join(desktopRoot, WINDOWS_STORE_ASSET_DIRECTORY);
  const { Resvg } = await import("@resvg/resvg-js");
  const source = await readFile(sourcePath);
  const sourceSize = readPngSize(source);
  if (sourceSize.width !== sourceSize.height) throw new TypeError("source icon must be square");
  await mkdir(outputDirectory, { recursive: true });
  const written = [];
  for (const asset of WINDOWS_STORE_ASSETS) {
    const png = new Resvg(windowsStoreAssetSvg(asset, source), {
      fitTo: { mode: "original" },
    })
      .render()
      .asPng();
    const size = readPngSize(png);
    if (size.width !== asset.width || size.height !== asset.height) {
      throw new Error("generated Store asset has unexpected dimensions");
    }
    const path = join(outputDirectory, asset.name);
    await writeAtomically(path, png);
    written.push(path);
  }
  return Object.freeze(written);
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  for (const path of await generateWindowsStoreAssets()) {
    process.stdout.write(`windows store asset: ${path}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("windows store asset generation failed\n");
    process.exitCode = 1;
  }
}

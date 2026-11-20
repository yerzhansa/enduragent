import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_STORE_ASSETS,
  WINDOWS_STORE_ASSET_DIRECTORY,
  readPngSize,
  windowsStoreAssetSvg,
} from "../scripts/generate-windows-store-assets.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = join(desktopRoot, WINDOWS_STORE_ASSET_DIRECTORY);

describe("Windows Store assets", () => {
  it("commits exactly the four required tile images at their declared sizes", async () => {
    const names = (await readdir(assetDirectory)).filter((name) => !name.startsWith(".")).sort();

    expect(names).toEqual([
      "Square150x150Logo.png",
      "Square44x44Logo.png",
      "StoreLogo.png",
      "Wide310x150Logo.png",
    ]);
    expect(WINDOWS_STORE_ASSETS.map((asset) => asset.name).sort()).toEqual(names);
    for (const asset of WINDOWS_STORE_ASSETS) {
      const size = readPngSize(await readFile(join(assetDirectory, asset.name)));
      expect(size).toEqual({ width: asset.width, height: asset.height });
      expect(asset.iconSize).toBeLessThanOrEqual(Math.min(asset.width, asset.height));
    }
  });

  it("centers the source icon on a transparent canvas", () => {
    const wide = WINDOWS_STORE_ASSETS.find((asset) => asset.name === "Wide310x150Logo.png")!;
    const svg = windowsStoreAssetSvg(wide, Buffer.from("synthetic"));

    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="310" height="150" viewBox="0 0 310 150">' +
        '<image x="105" y="25" width="100" height="100" href="data:image/png;base64,c3ludGhldGlj"/>' +
        "</svg>",
    );
  });

  it("rejects bytes that are not a PNG", () => {
    expect(() => readPngSize(Buffer.from("not a png"))).toThrow("invalid PNG image");
  });
});

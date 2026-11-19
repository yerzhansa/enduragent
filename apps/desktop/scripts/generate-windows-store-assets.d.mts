export interface WindowsStoreAsset {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly iconSize: number;
}

export const WINDOWS_STORE_ASSET_DIRECTORY: "build/appx";
export const WINDOWS_STORE_ASSETS: readonly WindowsStoreAsset[];
export function readPngSize(png: Buffer): { readonly width: number; readonly height: number };
export function windowsStoreAssetSvg(asset: WindowsStoreAsset, sourcePng: Buffer): string;
export function generateWindowsStoreAssets(input?: {
  readonly sourcePath?: string;
  readonly outputDirectory?: string;
}): Promise<readonly string[]>;

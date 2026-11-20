import type { CatalogKey } from "./catalog-keys.generated.js";

export type { CatalogKey } from "./catalog-keys.generated.js";

export interface Message {
  readonly key: CatalogKey;
  readonly vars?: Record<string, string | number>;
}

export function msg(key: CatalogKey, vars?: Record<string, string | number>): Message {
  return vars === undefined ? { key } : { key, vars };
}

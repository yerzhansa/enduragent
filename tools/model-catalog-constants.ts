export const MODEL_CATALOG_PUBLIC_URL =
  "https://api.enduragent.icu/models/v1/catalog.json" as const;
export const MODEL_CATALOG_PUBLIC_PATH = "/models/v1/catalog.json" as const;
export const MODEL_CATALOG_CURRENT_KEY = "current/catalog.json" as const;
export const MODEL_CATALOG_MAX_BYTES = 512 * 1_024;
export const MODEL_CATALOG_PUBLICATION_MAX_BYTES = 1024 * 1_024;
export const MODEL_CATALOG_RECORD_MAX_BYTES = 2 * 1_024 * 1_024;
export const MODEL_CATALOG_EDGE_MAX_AGE_SECONDS = 300;
export const MODEL_CATALOG_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
export const MODEL_CATALOG_PUBLICATION_FORMAT_VERSION = 1 as const;

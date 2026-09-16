import type { AcceptedModelCatalogRecord } from "@enduragent/core";

export type CatalogSession =
  | { readonly kind: "live"; readonly catalog: AcceptedModelCatalogRecord }
  | { readonly kind: "pinned"; readonly catalog: AcceptedModelCatalogRecord };

export const CatalogSession = {
  live(catalog: AcceptedModelCatalogRecord): CatalogSession {
    return { kind: "live", catalog };
  },
  pin(catalog: AcceptedModelCatalogRecord): CatalogSession {
    return { kind: "pinned", catalog };
  },
  forRebuild(
    session: CatalogSession,
    readLive: () => AcceptedModelCatalogRecord,
  ): AcceptedModelCatalogRecord {
    return session.kind === "pinned" ? session.catalog : readLive();
  },
};

import { describe, expect, it } from "vitest";
import { bundledAcceptedCatalog } from "../../core/src/model-catalog.js";
import { CatalogSession } from "../src/catalog-session.js";

describe("CatalogSession", () => {
  const liveCatalog = bundledAcceptedCatalog();
  const pinnedCatalog = Object.freeze({
    ...liveCatalog,
    snapshot: { ...liveCatalog.snapshot, revision: liveCatalog.snapshot.revision + 5 },
    effective: { ...liveCatalog.effective, revision: liveCatalog.effective.revision + 5 },
  });
  const advancedLive = Object.freeze({
    ...liveCatalog,
    snapshot: { ...liveCatalog.snapshot, revision: liveCatalog.snapshot.revision + 1 },
    effective: { ...liveCatalog.effective, revision: liveCatalog.effective.revision + 1 },
  });

  it("rebuilds a live session from the live owner, not the opening catalog", () => {
    const session = CatalogSession.live(liveCatalog);
    expect(CatalogSession.forRebuild(session, () => advancedLive)).toBe(advancedLive);
  });

  it("rebuilds a pinned session from the pin after the live owner advances", () => {
    const session = CatalogSession.pin(pinnedCatalog);
    expect(CatalogSession.forRebuild(session, () => advancedLive)).toBe(pinnedCatalog);
  });

  it("keeps a pin sticky when rebuild adopts a newer catalog copy", () => {
    let session = CatalogSession.live(liveCatalog);
    session = CatalogSession.pin(pinnedCatalog);
    session = { ...session, catalog: pinnedCatalog };
    expect(session.kind).toBe("pinned");
    expect(CatalogSession.forRebuild(session, () => advancedLive)).toBe(pinnedCatalog);
  });
});

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDesktopAthleteHome } from "../../../apps/desktop/src/main/first-run-config.js";
import { resolveAthleteHome } from "../../kernel-node/src/home/resolve-athlete-home.js";
import { resolveModelCatalogPaths } from "../src/model-catalog-owner.js";
import { resetOwnerCatalogFixtures, tempDirectory } from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog installation paths", () => {
  it("maps desktop, coach, and CLI home resolution to one installation record", () => {
    const installationRoot = tempDirectory("catalog-home-");
    const env = { ENDURAGENT_HOME: installationRoot };
    const desktopRoot = resolveDesktopAthleteHome(env);
    const hostRoot = resolveAthleteHome(env).root;
    const desktopPaths = resolveModelCatalogPaths({
      cacheDirectory: join(installationRoot, "desktop-cache"),
      installationRoot: desktopRoot,
    });
    const hostPaths = resolveModelCatalogPaths({
      cacheDirectory: join(installationRoot, "coach-cache"),
      installationRoot: hostRoot,
    });

    expect(desktopRoot).toBe(hostRoot);
    expect(desktopPaths.attemptState).toBe(hostPaths.attemptState);
    expect(desktopPaths.ownerSnapshot).toBe(hostPaths.ownerSnapshot);
    expect(desktopPaths.privateSnapshot).not.toBe(hostPaths.privateSnapshot);
  });
});

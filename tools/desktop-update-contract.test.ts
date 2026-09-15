import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  DESKTOP_FEED_URL,
  GITHUB_DESKTOP_RELEASE_FEED_URL,
} from "./desktop-update-contract.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("pins the desktop update contract and release workflow", () => {
  expect(GITHUB_DESKTOP_RELEASE_FEED_URL).toBe(
    "https://github.com/yerzhansa/enduragent/releases/latest/download/",
  );
  expect(DESKTOP_FEED_URL).toBe("https://updates.enduragent.icu/");

  const workflow = readFileSync(
    join(repositoryRoot, ".github/workflows/desktop-release.yml"),
    "utf8",
  );
  expect(workflow).toContain(`ENDURAGENT_DESKTOP_UPDATE_URL: ${DESKTOP_FEED_URL}`);
  expect(workflow).toContain(`PUBLIC_FEED: ${DESKTOP_FEED_URL}`);
  expect(workflow).toContain("Require the public updater feed");
  expect(workflow).toContain('${PUBLIC_FEED}latest-mac.yml');
  expect(workflow).toContain('${PUBLIC_FEED}Enduragent-arm64.dmg');
  expect(workflow).toContain(
    "https://github.com/$GITHUB_REPOSITORY/releases/latest/download/latest-mac.yml",
  );
  expect(workflow).not.toContain('curl -fsSL "$public_yaml"');
  expect(workflow).not.toContain('curl -fsSIL "${PUBLIC_FEED}');
});

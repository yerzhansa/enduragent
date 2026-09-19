import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const featureDirectory = resolve(
  repositoryRoot,
  ".agents/skills/verify-enduragent/references/features",
);
const manifestDirectory = resolve(
  repositoryRoot,
  "apps/desktop/tests/fixtures/windows-parity",
);
const indexSource = readFileSync(resolve(featureDirectory, "README.md"), "utf8");

type ManifestScenario = {
  id: string;
  automation: string;
  test?: string;
  tests?: string[];
};

function featureEntries(): Array<{ label: string; page: string }> {
  return indexSource
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("|") &&
        !/^\|\s*Feature\s*\|/.test(line) &&
        !/^\|\s*-+\s*\|/.test(line),
    )
    .map((line) => {
      const row = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/.exec(line);
      if (!row) {
        throw new Error(`Invalid feature index row: ${line}`);
      }

      const link = /^\[`[^`]+\.md`\]\(([^)]+\.md)\)/.exec(row[2]);
      if (!link) {
        throw new Error(`Missing local Markdown feature link: ${line}`);
      }

      return { label: row[1], page: link[1] };
    });
}

function scenarioIds(source: string): string[] {
  return [
    ...source.matchAll(
      /`((?:chat|settings|training|shell|daemon|telegram)\.[^`\s]+)`/gi,
    ),
  ].map((match) => match[1]);
}

function scenarioCatalog(): Map<string, ManifestScenario> {
  const catalog = new Map<string, ManifestScenario>();

  for (const file of readdirSync(manifestDirectory).filter((name) =>
    name.endsWith(".scenarios.json"),
  )) {
    const manifest = JSON.parse(
      readFileSync(resolve(manifestDirectory, file), "utf8"),
    ) as { scenarios: ManifestScenario[] };

    for (const scenario of manifest.scenarios) {
      expect(catalog.has(scenario.id), scenario.id).toBe(false);
      catalog.set(scenario.id, scenario);
    }
  }

  return catalog;
}

describe("verification feature catalog", () => {
  it("indexes every local feature page exactly once", () => {
    const entries = featureEntries();
    const labels = entries.map(({ label }) => label);
    const pages = entries.map(({ page }) => page);
    const featurePages = readdirSync(featureDirectory)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();

    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(pages).size).toBe(pages.length);

    for (const page of pages) {
      expect(page).toBe(basename(page));
      expect(existsSync(resolve(featureDirectory, page))).toBe(true);
    }

    expect([...pages].sort()).toEqual(featurePages);
  });

  it("uses the exact feature page H2 sequence", () => {
    const expectedHeadings = [
      "## Sub-features",
      "## How to get to it (user POV)",
      "## Driving it with verify-enduragent",
      "## Gotchas",
    ];

    for (const { page } of featureEntries()) {
      const source = readFileSync(resolve(featureDirectory, page), "utf8");
      expect(source.match(/^## .+$/gm) ?? [], page).toEqual(expectedHeadings);
    }
  });

  it("maps valid scenario IDs to exactly one feature page", () => {
    const catalog = scenarioCatalog();
    const ownership = new Map<string, string>();

    for (const { page } of featureEntries()) {
      const source = readFileSync(resolve(featureDirectory, page), "utf8");

      for (const id of scenarioIds(source)) {
        expect(catalog.has(id), `${page}: ${id}`).toBe(true);
        expect(ownership.has(id), `${id}: ${ownership.get(id)} and ${page}`).toBe(
          false,
        );
        ownership.set(id, page);
      }
    }

    expect(ownership.size).toBeGreaterThan(0);
  });

  it("names only supported executors", () => {
    const supported = new Set(["cdp", "playwright", "vitest", "s8a", "manual"]);

    for (const { page } of featureEntries()) {
      const source = readFileSync(resolve(featureDirectory, page), "utf8");
      const executorLines = source
        .split("\n")
        .filter((line) => /\bexecutors?\b/i.test(line));
      const named = [
        ...executorLines
          .join("\n")
          .matchAll(/\b(cdp|playwright|vitest|s8a|manual)\b/gi),
      ].map((match) => match[1].toLowerCase());
      const explicit = executorLines.flatMap((line) =>
        [
          ...line
            .slice(line.search(/\bexecutors?\b/i))
            .matchAll(/`([a-z][a-z0-9-]*)`/gi),
        ].map((match) => match[1].toLowerCase()),
      );

      expect(named.length, page).toBeGreaterThan(0);
      expect(
        explicit.filter((name) => name !== "vm-only" && !supported.has(name)),
        page,
      ).toEqual([]);
    }
  });

  it("resolves deterministic and inline test citations", () => {
    const catalog = scenarioCatalog();

    for (const { page } of featureEntries()) {
      const source = readFileSync(resolve(featureDirectory, page), "utf8");

      for (const id of scenarioIds(source)) {
        const scenario = catalog.get(id);
        expect(scenario, `${page}: ${id}`).toBeDefined();
        if (scenario?.automation !== "deterministic") continue;
        const citations = [
          ...(scenario.test ? [scenario.test] : []),
          ...(scenario.tests ?? []),
        ];
        expect(citations.length, id).toBeGreaterThan(0);
        for (const citation of citations) {
          expect(
            existsSync(resolve(repositoryRoot, citation.split(" > ")[0])),
            id,
          ).toBe(true);
        }
      }

      const inlineCitations = [
        ...source.matchAll(
          /`((?:apps|packages)\/[^`\s]+\/tests\/[^`\s]+\.(?:test|spec)\.tsx?)`/g,
        ),
      ].map((match) => match[1]);
      for (const citation of inlineCitations) {
        expect(
          existsSync(resolve(repositoryRoot, citation)),
          `${page}: ${citation}`,
        ).toBe(true);
      }
    }
  });
});

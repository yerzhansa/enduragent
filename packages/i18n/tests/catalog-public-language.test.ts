import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("uses plain training terms in every catalog value", () => {
  const directory = new URL("../catalogs/", import.meta.url);
  const catalogs = readdirSync(directory).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".meta.json"),
  );
  const findings: string[] = [];

  for (const name of catalogs) {
    const catalog: unknown = JSON.parse(readFileSync(new URL(name, directory), "utf8"));
    const pending: [string, unknown][] = [[name, catalog]];

    for (const [path, value] of pending) {
      if (typeof value === "string") {
        const terms = value.match(/\b(?:CTL|ATL|TSB|TSS|IF|NP|Normalized\s+Power)\b/g);
        if (terms !== null) {
          findings.push(`${path}: ${terms.join(", ")}; use plain training terms`);
        }
      } else if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          pending.push([`${path}.${key}`, entry]);
        }
      }
    }
  }

  expect(findings).toEqual([]);
});

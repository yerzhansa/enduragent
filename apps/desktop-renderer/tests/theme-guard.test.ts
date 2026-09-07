import { readUiStylesheet } from "./ui-styles";
import { readdir, readFile } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..", "src");

const DARK_MEDIA = /prefers-color-scheme:\s*dark/u;
const SYSTEM_DARK_GUARD = ':not([data-theme="light"])';
const EXPLICIT_DARK_GUARD = '[data-theme="dark"]';
const RUNTIME_PROPERTIES = new Set(["--chat-composer-clearance"]);
const CONTROL_ELEMENTS = ["button", "a", "input", "textarea", "select"] as const;
const FONT_INHERIT_ELEMENTS = ["button", "input", "textarea", "select"] as const;
const FOCUS = ":focus-visible";
const OUTLINE_CLEARED = /outline:\s*(?:0|none)\b/u;

interface ParsedRule {
  readonly selector: string;
  readonly media: string | undefined;
  readonly raw: string;
  readonly declarations: ReadonlyMap<string, string>;
}

function readBlock(source: string, openIndex: number): { body: string; end: number } {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(openIndex + 1, index), end: index + 1 };
    }
  }
  throw new Error("Unbalanced CSS block");
}

function customProperties(body: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/gu))
    declarations.set(match[1], match[2].trim());
  return declarations;
}

function collect(source: string, media: string | undefined, into: ParsedRule[]): void {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open === -1) return;
    const prelude = source.slice(index, open).trim();
    const { body, end } = readBlock(source, open);
    if (prelude.startsWith("@layer")) collect(body, media, into);
    else if (prelude.startsWith("@")) collect(body, prelude, into);
    else into.push({ selector: prelude, media, raw: body, declarations: customProperties(body) });
    index = end;
  }
}

function selectors(rule: ParsedRule): readonly string[] {
  return rule.selector
    .split(",")
    .map((part) => part.replaceAll(/\s+/gu, " ").trim())
    .filter((part) => part.length > 0);
}

function parse(source: string): readonly ParsedRule[] {
  const rules: ParsedRule[] = [];
  collect(source.replace(/\/\*[\s\S]*?\*\//gu, ""), undefined, rules);
  return rules;
}

async function stylesheets(): Promise<readonly string[]> {
  const entries = await readdir(sourceRoot, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => entry.split(sep).join(posix.sep))
    .sort();
}

describe("theme guards", () => {
  it("gates every system-dark custom property behind the explicit light override", async () => {
    const files = await stylesheets();
    expect(files).toContain("theme/application.css");

    let guarded = 0;
    for (const file of [...files, "@enduragent/ui/tokens.css"]) {
      const rules = parse(
        file === "@enduragent/ui/tokens.css"
          ? await readUiStylesheet("tokens.css")
          : await readFile(resolve(sourceRoot, file), "utf8"),
      );
      for (const rule of rules) {
        if (rule.media === undefined || !DARK_MEDIA.test(rule.media)) continue;
        if (rule.declarations.size === 0) continue;
        guarded += 1;
        expect(`${file} ${rule.selector}`).toContain(SYSTEM_DARK_GUARD);
      }
    }
    expect(guarded).toBeGreaterThanOrEqual(1);
  });

  it("mirrors every system-dark custom property onto the stamped dark theme", async () => {
    for (const file of [...(await stylesheets()), "@enduragent/ui/tokens.css"]) {
      const rules = parse(
        file === "@enduragent/ui/tokens.css"
          ? await readUiStylesheet("tokens.css")
          : await readFile(resolve(sourceRoot, file), "utf8"),
      );
      const stamped = rules.filter(
        (rule) => rule.media === undefined && rule.selector.includes(EXPLICIT_DARK_GUARD),
      );
      for (const rule of rules) {
        if (rule.media === undefined || !DARK_MEDIA.test(rule.media)) continue;
        for (const [property, value] of rule.declarations) {
          const mirrored = stamped.some(
            (candidate) => candidate.declarations.get(property) === value,
          );
          expect(`${file} ${property}: ${value} mirrored=${String(mirrored)}`).toContain(
            "mirrored=true",
          );
        }
      }
    }
  });

  it("stamps the colour scheme for both explicit themes", async () => {
    const tokens = parse(await readUiStylesheet("tokens.css"));
    for (const [selector, scheme] of [
      [':root[data-theme="light"]', "light"],
      [':root[data-theme="dark"]', "dark"],
    ] as const)
      expect(
        tokens.some(
          (rule) =>
            rule.media === undefined &&
            rule.selector === selector &&
            new RegExp(`color-scheme:\\s*${scheme}\\s*;`, "u").test(rule.raw),
        ),
      ).toBe(true);
  });

  it("resolves every referenced custom property from the theme vocabulary", async () => {
    const tokens = parse(await readUiStylesheet("tokens.css"));
    const declared = new Set(
      tokens.flatMap((rule) =>
        rule.selector.startsWith(":root") ? [...rule.declarations.keys()] : [],
      ),
    );
    expect(declared.size).toBeGreaterThanOrEqual(20);

    expect(await stylesheets()).toContain("theme/application.css");
    const application = await readFile(resolve(sourceRoot, "theme/application.css"), "utf8");
    expect(application.match(/@import "@enduragent\/ui\/tailwind.css";/gu)).toHaveLength(1);
    expect(application.match(/tailwindcss\/preflight.css/gu)).toHaveLength(1);
    const undeclared: string[] = [];
    for (const file of await stylesheets()) {
      const source = await readFile(resolve(sourceRoot, file), "utf8");
      for (const match of source.matchAll(/var\(\s*(--[\w-]+)/gu)) {
        const property = match[1];
        if (RUNTIME_PROPERTIES.has(property) || declared.has(property)) continue;
        undeclared.push(`${file} ${property}`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});

describe("control reset", () => {
  it("inherits the interface font on every control element", async () => {
    const tokens = parse(await readUiStylesheet("tokens.css"));
    const inherited = new Set(
      tokens
        .filter((rule) => rule.media === undefined && /font:\s*inherit/u.test(rule.raw))
        .flatMap((rule) => selectors(rule)),
    );
    for (const element of FONT_INHERIT_ELEMENTS) expect([...inherited]).toContain(element);
  });

  it("rings every keyboard-focused control with the neutral outline", async () => {
    const tokens = parse(await readUiStylesheet("tokens.css"));
    const focus = tokens.filter(
      (rule) => rule.media === undefined && selectors(rule).some((part) => part.includes(FOCUS)),
    );
    expect(focus).toHaveLength(1);
    expect([...selectors(focus[0])].sort()).toEqual(
      [...CONTROL_ELEMENTS].map((element) => `${element}${FOCUS}`).sort(),
    );
    expect(focus[0].raw.replaceAll(/\s+/gu, " ")).toContain("outline: 2px solid var(--ink)");
    expect(focus[0].raw.replaceAll(/\s+/gu, " ")).toContain("outline-offset: 1px");
  });

  it("suppresses the focus ring only through focus-qualified selectors", async () => {
    const unqualified: string[] = [];
    for (const file of await stylesheets()) {
      const cleared = parse(await readFile(resolve(sourceRoot, file), "utf8")).filter((rule) =>
        OUTLINE_CLEARED.test(rule.raw),
      );
      const focused = new Set(
        cleared
          .filter((rule) => selectors(rule).every((part) => part.endsWith(FOCUS)))
          .map((rule) => selectors(rule).join(",")),
      );
      for (const rule of cleared) {
        const parts = selectors(rule);
        if (parts.every((part) => part.endsWith(FOCUS))) continue;
        if (focused.has(parts.map((part) => `${part}${FOCUS}`).join(","))) continue;
        unqualified.push(`${file} ${parts.join(", ")}`);
      }
    }
    expect(unqualified).toEqual([]);
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("tray popover markup", () => {
  it("has the exact passive CSP and semantic two-card identity", async () => {
    const html = await readFile(resolve(root, "tray.html"), "utf8");
    expect(html).toContain(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(html).toContain('aria-label="Enduragent menu bar status"');
    expect(html).toContain('aria-label="Enduragent is running"');
    expect(html).toContain('aria-labelledby="residency-heading"');
    expect(html.match(/<article\s+class="[^"]*\brail-card\b[^"]*"/gu)).toHaveLength(2);
    for (const copy of [
      "Cycling coach",
      "Ready when you are",
      "Residency",
      "Running in the menu bar",
      "Telegram",
      "Checking connection",
    ])
      expect(html).toContain(copy);
    expect(html).not.toMatch(/<(?:button|a|form|input|canvas|svg)\b/iu);
    expect(html).not.toMatch(/\s(?:style|on\w+)=/iu);
    expect(html).not.toMatch(/<script(?![^>]+src=)/iu);
  });

  it("keeps script and styling passive and local", async () => {
    const [html, script] = await Promise.all([
      readFile(resolve(root, "tray.html"), "utf8"),
      readFile(resolve(root, "src/tray.ts"), "utf8"),
    ]);
    const source = `${html}\n${script}`;
    expect(html).toContain('href="/src/theme/application.css"');
    expect(html).not.toContain("tray.css");
    expect(html).toContain("dark:");
    expect(html).toContain("motion-reduce:transition-none");
    expect(script).toContain('from "./tray-status"');
    expect(script).toContain("window.enduragentTray.onTelegramStatus");
    expect(script).toContain('event.key === "Escape"');
    expect(source).not.toMatch(
      /fetch\s*\(|WebSocket|ipcRenderer|contextBridge|localStorage|sessionStorage|console\.|@enduragent\/|https?:|[?#]token/iu,
    );
    expect(source).not.toMatch(
      /\b(?:Fitness|Fatigue|Load|Intensity|workout|wellness|plan|spend|onboarding|chat)\b/iu,
    );
    expect(html).not.toMatch(/>\s*Form\s*</iu);
  });
});

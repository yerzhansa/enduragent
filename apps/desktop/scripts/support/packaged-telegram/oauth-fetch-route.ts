import { readFileSync } from "node:fs";
import { join } from "node:path";

export function requireOAuthAcceptanceOrigin(value: string | undefined): string {
  const url = new URL(value ?? "invalid");
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    Number(url.port) === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  )
    throw new TypeError("OAuth acceptance origin is invalid");
  return url.origin;
}

export function requireOAuthAcceptanceIdentity(
  environment: NodeJS.ProcessEnv,
  manifest: unknown,
): void {
  if (
    environment.ENDURAGENT_ACCEPTANCE_HIDDEN !== "1" ||
    environment.ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT !== "1" ||
    environment.ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND !== "file" ||
    manifest === null ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    manifest.name !== "enduragent-desktop-telegram-acceptance" ||
    !("productName" in manifest) ||
    manifest.productName !== "Enduragent Telegram Acceptance" ||
    !("enduragentDesktopTelegramAcceptance" in manifest) ||
    manifest.enduragentDesktopTelegramAcceptance !== true
  )
    throw new TypeError("OAuth acceptance package identity is invalid");
}

export function createOAuthAcceptanceFetch(
  original: typeof fetch,
  origin: string,
  role: "main" | "utility",
): typeof fetch {
  const destination = requireOAuthAcceptanceOrigin(origin);
  const expected =
    role === "main"
      ? "https://auth.openai.com/oauth/token"
      : "https://chatgpt.com/backend-api/codex/responses";
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href !== expected) throw new TypeError("Unexpected OAuth acceptance network request");
    if (input instanceof Request)
      throw new TypeError("OAuth acceptance Request input is unsupported");
    return original(`${destination}${url.pathname}`, { ...init, redirect: "error" });
  };
}

export function createOAuthAcceptanceBrowser(
  original: typeof fetch,
  origin: string,
): (url: string) => Promise<void> {
  const destination = requireOAuthAcceptanceOrigin(origin);
  return async (value) => {
    const url = new URL(value);
    if (
      url.origin !== "https://auth.openai.com" ||
      url.pathname !== "/oauth/authorize" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.get("redirect_uri") !== "http://localhost:1455/auth/callback" ||
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") ||
      !/^[a-f0-9]{32}$/.test(url.searchParams.get("state") ?? "")
    ) throw new TypeError("Unexpected OAuth acceptance browser request");
    const response = await original(`${destination}/authorize${url.search}`, { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("OAuth acceptance authorization failed");
  };
}

export function installOAuthAcceptanceRoute(
  role: "main" | "utility",
  browser?: { openExternal: (url: string) => Promise<void> },
): void {
  const configured = process.env.ENDURAGENT_ACCEPTANCE_OAUTH_ORIGIN;
  if (configured === undefined) return;
  if (!import.meta.dirname.includes("/app.asar/") || process.versions.electron === undefined) {
    throw new TypeError("OAuth acceptance requires a packaged Electron process");
  }
  const source = readFileSync(join(import.meta.dirname, "../../package.json"), "utf8");
  if (source.length > 65536) throw new TypeError("OAuth acceptance manifest is too large");
  const manifest: unknown = JSON.parse(source);
  requireOAuthAcceptanceIdentity(process.env, manifest);
  const origin = requireOAuthAcceptanceOrigin(configured);
  const original = globalThis.fetch;
  globalThis.fetch = createOAuthAcceptanceFetch(original, origin, role);
  if (role === "main") {
    if (browser === undefined) throw new TypeError("OAuth acceptance browser port is missing");
    browser.openExternal = createOAuthAcceptanceBrowser(original, origin);
  } else {
    delete process.env.ENDURAGENT_ACCEPTANCE_OAUTH_ORIGIN;
  }
}

import { join } from "node:path";
import { CONFIG_DIR } from "../config.js";
import { assertCliOAuthHome } from "./profile-store.js";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { note, text, isCancel, log } from "@clack/prompts";
import { loginCodex } from "../agent/codex/oauth.js";
import type { CodexLoginProgressPhase } from "../agent/codex/oauth.js";
import type { OAuthCredential } from "./profiles.js";

const LOCAL_CALLBACK_FALLBACK_MS = 120_000;

const OAUTH_PROGRESS_COPY: Readonly<Record<CodexLoginProgressPhase, string>> = {
  "waiting-for-browser": "Waiting for browser sign-in…",
  "completing-sign-in": "Completing ChatGPT sign-in…",
};

function isHeadless(): boolean {
  if (!process.stdout.isTTY) return true;
  if (process.env.SSH_CONNECTION) return true;
  if (process.platform === "linux" && !process.env.DISPLAY) return true;
  return false;
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // Fall through — the URL is also printed for manual paste.
  }
}

async function promptForCode(message: string, signal: AbortSignal): Promise<string> {
  const value = await text({
    message,
    signal,
    validate: (v) => (!v ? "Value is required" : undefined),
  });
  signal.throwIfAborted();
  if (isCancel(value)) throw new Error("OAuth cancelled by user");
  return typeof value === "string" ? value : "";
}

export async function runCodexLogin(): Promise<OAuthCredential> {
  assertCliOAuthHome(join(CONFIG_DIR, "auth-profiles.json"));
  const headless = isHeadless();

  const creds = await loginCodex({
    originator: "cycling-coach",
    onAuth: ({ url }) => {
      if (headless) {
        note(
          [
            "Headless environment detected.",
            "Open this URL in a browser on your LOCAL machine,",
            "complete sign-in, then paste the redirect URL back here.",
          ].join("\n"),
          "OpenAI Codex OAuth",
        );
      } else {
        note(
          "A browser will open for OpenAI sign-in.\nIf it doesn't open, copy the URL below:",
          "OpenAI Codex OAuth",
        );
      }
      // Print the URL outside the boxed note so long links are not hard-wrapped
      // with whitespace/newlines inserted by the box renderer.
      console.log(url);
      if (!headless) openUrl(url);
    },
    onPrompt: async (prompt) => await promptForCode(prompt.message, prompt.signal),
    onProgress: (phase) => log.info(OAUTH_PROGRESS_COPY[phase]),
    onManualCodeInput: async (signal) => {
      if (!headless) {
        await delay(LOCAL_CALLBACK_FALLBACK_MS, undefined, { signal });
      }
      return await promptForCode("Paste the authorization code (or full redirect URL)", signal);
    },
  });

  return {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: typeof creds.accountId === "string" ? creds.accountId : undefined,
    email: typeof creds.email === "string" ? creds.email : undefined,
  };
}

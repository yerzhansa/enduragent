import { readBinaryPackageJson, type UpdateInfo } from "./updater.js";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { cliPhrasebook } from "./cli-copy.js";

export interface RepoInfo {
  owner: string;
  name: string;
}

export type ReleaseNotesResult =
  | {
      status: "available";
      version: string;
      notes: readonly string[];
      releaseUrl: string;
    }
  | {
      status: "unavailable";
      version: string | null;
      releaseUrl: string;
    };

export type ReleaseNotesFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchLatestReleaseNotesOptions {
  fetch?: ReleaseNotesFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;
const MAX_VERSION_LENGTH = 64;
const MAX_NOTES = 100;
const MAX_NOTE_LENGTH = 2000;
const MAX_TOTAL_NOTE_BYTES = 64 * 1024;
const MAX_RELEASE_URL_LENGTH = 2048;
const MAX_BINARY_NAME_LENGTH = 214;
const INVALID_REPOSITORY_RELEASES_URL = "https://github.com/_/_/releases";

const BINARY_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USER_FACING_LINE_RE =
  /^[ \t]*(?:[-*+][ \t]+(?:[0-9a-f]{7,}:[ \t]+)?)?User-facing:[ \t]*(.*?)[ \t\r]*$/i;

export function parseRepoFromUrl(url: string): RepoInfo | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:#.*)?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

export function getRepoForBinary(binaryName: string): RepoInfo | null {
  const pkg = readBinaryPackageJson(binaryName);
  const repo = pkg?.repository as { url?: string } | string | undefined;
  const url = typeof repo === "string" ? repo : repo?.url;
  return url ? parseRepoFromUrl(url) : null;
}

function parseUserFacingBounded(body: string): string[] | null {
  const out: string[] = [];
  let totalBytes = 0;
  const encoder = new TextEncoder();

  for (const raw of body.split("\n")) {
    const m = USER_FACING_LINE_RE.exec(raw);
    const note = m?.[1]?.trim();
    if (!note) continue;
    if (note.length > MAX_NOTE_LENGTH || out.length === MAX_NOTES) return null;
    totalBytes += encoder.encode(note).byteLength;
    if (totalBytes > MAX_TOTAL_NOTE_BYTES) return null;
    out.push(note);
  }
  return out;
}

export function parseUserFacing(body: string): string[] {
  return parseUserFacingBounded(body) ?? [];
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request has already failed closed.
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await cancelResponseBody(response);
    return null;
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (signal.aborted) {
    try {
      await reader.cancel();
    } catch {
      // The request has already failed closed.
    }
    reader.releaseLock();
    return null;
  }
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already rejected; cancellation is best-effort.
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return null;
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort();
    throw new Error("Release notes request aborted");
  }

  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => {
    controller.abort();
    rejectAbort(new Error("Release notes request aborted"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function fetchBoundedJson(
  fetchImpl: ReleaseNotesFetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  headers?: RequestInit["headers"],
): Promise<unknown | null> {
  try {
    return await withDeadline(
      timeoutMs,
      async (requestSignal) => {
        const response = await fetchImpl(url, {
          headers,
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          await cancelResponseBody(response);
          return null;
        }
        const text = await readBoundedText(response, maxBytes, requestSignal);
        if (text === null) return null;
        return JSON.parse(text) as unknown;
      },
      signal,
    );
  } catch {
    return null;
  }
}

function isSafeBinaryName(binaryName: string): boolean {
  return (
    binaryName.length > 0 &&
    binaryName.length <= MAX_BINARY_NAME_LENGTH &&
    BINARY_NAME_RE.test(binaryName)
  );
}

function isSafeVersion(version: unknown): version is string {
  return (
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= MAX_VERSION_LENGTH &&
    VERSION_RE.test(version)
  );
}

function repositoryReleasesUrl(repo: RepoInfo): string | null {
  if (!repo.owner || !repo.name) return null;
  const url =
    `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}` +
    "/releases";
  return url.length <= MAX_RELEASE_URL_LENGTH ? url : null;
}

function encodedTag(binaryName: string, version: string): string {
  return encodeURIComponent(`${binaryName}@${version}`).replace(/%40/gi, "@");
}

function releaseTagUrl(releasesUrl: string, binaryName: string, version: string): string | null {
  const url = `${releasesUrl}/tag/${encodedTag(binaryName, version)}`;
  return url.length <= MAX_RELEASE_URL_LENGTH ? url : null;
}

function unavailable(version: string | null, releaseUrl: string): ReleaseNotesResult {
  return { status: "unavailable", version, releaseUrl };
}

export async function fetchLatestReleaseNotes(
  binaryName: string,
  repo: RepoInfo,
  options: FetchLatestReleaseNotesOptions = {},
): Promise<ReleaseNotesResult> {
  const releasesUrl = repositoryReleasesUrl(repo);
  if (releasesUrl === null || !isSafeBinaryName(binaryName)) {
    return unavailable(null, releasesUrl ?? INVALID_REPOSITORY_RELEASES_URL);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs as number)))
      : DEFAULT_TIMEOUT_MS;

  try {
    const registryData = await fetchBoundedJson(
      fetchImpl,
      `${NPM_REGISTRY}/${encodeURIComponent(binaryName)}/latest`,
      MAX_REGISTRY_RESPONSE_BYTES,
      timeoutMs,
      options.signal,
    );
    const version =
      typeof registryData === "object" && registryData !== null && "version" in registryData
        ? (registryData as { version?: unknown }).version
        : null;
    if (!isSafeVersion(version)) return unavailable(null, releasesUrl);

    const releaseUrl = releaseTagUrl(releasesUrl, binaryName, version);
    if (releaseUrl === null) return unavailable(version, releasesUrl);

    const tag = encodedTag(binaryName, version);
    const releaseData = await fetchBoundedJson(
      fetchImpl,
      `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}` +
        `/releases/tags/${tag}`,
      MAX_GITHUB_RESPONSE_BYTES,
      timeoutMs,
      options.signal,
      { Accept: "application/vnd.github+json" },
    );
    if (typeof releaseData !== "object" || releaseData === null) {
      return unavailable(version, releaseUrl);
    }

    const body = (releaseData as { body?: unknown }).body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return unavailable(version, releaseUrl);
    }
    const notes = parseUserFacingBounded(typeof body === "string" ? body : "");
    if (notes === null) return unavailable(version, releaseUrl);
    return { status: "available", version, notes, releaseUrl };
  } catch {
    return unavailable(null, releasesUrl);
  }
}

export async function fetchReleaseBody(
  repo: RepoInfo,
  tag: string,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const data = await fetchBoundedJson(
      globalThis.fetch,
      `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}` +
        `/releases/tags/${encodeURIComponent(tag)}`,
      MAX_GITHUB_RESPONSE_BYTES,
      timeoutMs,
      undefined,
      { Accept: "application/vnd.github+json" },
    );
    if (typeof data !== "object" || data === null) return null;
    const body = (data as { body?: unknown }).body;
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

/**
 * Build the `/whatsnew` reply for the latest published version of `binaryName`.
 * Always shows the latest version's notes (per product decision) — when the
 * user is up to date that's their version's notes; when behind, it's a preview
 * of what `/update` will install. Renders only `User-facing:` lines extracted
 * from the GitHub Release body; engineering details and changeset hashes never
 * surface to athletes.
 */
export async function buildWhatsNewMessage(
  binaryName: string,
  info: UpdateInfo,
  book: Phrasebook = cliPhrasebook(),
): Promise<string> {
  const repo = getRepoForBinary(binaryName);
  if (!repo) {
    return book.say("telegram.release.repositoryMissing", {
      service: "GitHub",
      binary: binaryName,
    });
  }

  const tag = `${binaryName}@${info.latest}`;
  const releaseUrl = `https://github.com/${repo.owner}/${repo.name}/releases/tag/${tag}`;
  const body = await fetchReleaseBody(repo, tag);

  const lines: string[] = [];
  lines.push(book.say("telegram.release.heading", { version: info.latest }));
  lines.push("");

  if (body === null) {
    lines.push(
      book.say("telegram.release.fetchUnavailable", { service: "GitHub", url: releaseUrl }),
    );
  } else {
    const userFacing = parseUserFacing(body);
    if (userFacing.length > 0) {
      for (const line of userFacing) lines.push(`- ${line}`);
    } else {
      lines.push(book.say("telegram.release.noSummary"));
      lines.push(book.say("telegram.release.fullNotes", { url: releaseUrl }));
    }
  }

  lines.push("");
  if (info.updateAvailable) {
    lines.push(
      book.say("telegram.release.install", {
        current: info.current,
        command: "/update",
        latest: info.latest,
      }),
    );
  } else {
    lines.push(book.say("telegram.release.upToDate"));
  }

  return lines.join("\n");
}

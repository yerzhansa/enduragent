export const GITHUB_DESKTOP_RELEASE_FEED_URL =
  "https://github.com/yerzhansa/enduragent/releases/latest/download/" as const;
export const DESKTOP_FEED_URL = "https://updates.enduragent.icu/" as const;

const FEED_OBJECT =
  /^(?:latest(?:-mac)?\.yml|Enduragent-(?:arm64|\d+\.\d+\.\d+-arm64)\.dmg|Enduragent-\d+\.\d+\.\d+-arm64\.zip(?:\.blockmap)?|Enduragent-\d+\.\d+\.\d+-x64\.exe(?:\.blockmap)?)$/u;

const MAX_REDIRECTS = 10;
const USER_AGENT = "EnduragentDesktopUpdateFeed/1";
const YAML_CACHE = "public, max-age=60";
const VERSIONED_CACHE = "public, max-age=31536000, immutable";
const ALIAS_CACHE = "public, max-age=60";
const FORWARDED_REQUEST_HEADERS = ["range", "if-none-match", "if-modified-since"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

export interface DesktopUpdateFeedFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export function desktopUpdateFeedObjectName(pathname: string): string | undefined {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    return undefined;
  }
  if (pathname.includes("//") || pathname.includes("..") || pathname.includes("@")) {
    return undefined;
  }
  const name = pathname.slice(1);
  if (name.length === 0 || name.includes("/") || !FEED_OBJECT.test(name)) return undefined;
  return name;
}

export function githubDesktopReleaseObjectUrl(name: string): string {
  if (desktopUpdateFeedObjectName(`/${name}`) !== name) {
    throw new TypeError("desktop update feed object is invalid");
  }
  return `${GITHUB_DESKTOP_RELEASE_FEED_URL}${name}`;
}

function allowedUpstream(url: URL): boolean {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return host === "github.com" || host.endsWith(".githubusercontent.com");
}

function cacheControlFor(name: string): string {
  if (name === "latest-mac.yml" || name === "latest.yml" || name === "Enduragent-arm64.dmg") {
    return name.endsWith(".yml") ? YAML_CACHE : ALIAS_CACHE;
  }
  return VERSIONED_CACHE;
}

function copyRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  headers.set("User-Agent", USER_AGENT);
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && value !== "") headers.set(name, value);
  }
  return headers;
}

function publicHeaders(objectName: string, upstream: Headers): Headers {
  const headers = new Headers();
  for (const headerName of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(headerName);
    if (value !== null && value !== "") headers.set(headerName, value);
  }
  headers.set("Cache-Control", cacheControlFor(objectName));
  return headers;
}

export async function handleDesktopUpdateFeedRequest(
  request: Request,
  dependencies: { readonly fetch?: DesktopUpdateFeedFetch } = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const name = desktopUpdateFeedObjectName(new URL(request.url).pathname);
  if (name === undefined) return new Response(null, { status: 404 });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  let upstreamUrl = githubDesktopReleaseObjectUrl(name);
  const outbound = copyRequestHeaders(request.headers);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let parsed: URL;
    try {
      parsed = new URL(upstreamUrl);
    } catch {
      return new Response(null, { status: 502 });
    }
    if (!allowedUpstream(parsed)) return new Response(null, { status: 502 });
    const upstream = await fetchImpl(parsed, {
      method: request.method,
      headers: outbound,
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel();
      if (location === null || location === "") return new Response(null, { status: 502 });
      try {
        upstreamUrl = new URL(location, parsed).href;
      } catch {
        return new Response(null, { status: 502 });
      }
      continue;
    }
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      return new Response(null, { status: 404 });
    }
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 304) {
      await upstream.body?.cancel();
      return new Response(null, { status: 502 });
    }
    if (request.method === "HEAD") {
      await upstream.body?.cancel();
      return new Response(null, {
        status: upstream.status,
        headers: publicHeaders(name, upstream.headers),
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: publicHeaders(name, upstream.headers),
    });
  }
  return new Response(null, { status: 502 });
}

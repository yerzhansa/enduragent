import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_FEED_URL,
  GITHUB_DESKTOP_RELEASE_FEED_URL,
  desktopUpdateFeedObjectName,
  githubDesktopReleaseObjectUrl,
  handleDesktopUpdateFeedRequest,
} from "./desktop-update-feed.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const yamlBody = "version: 0.4.0\npath: Enduragent-0.4.0-arm64.zip\n";
const githubLatest = `${GITHUB_DESKTOP_RELEASE_FEED_URL}latest-mac.yml`;
const githubTagged =
  "https://github.com/yerzhansa/enduragent/releases/download/enduragent-desktop@0.4.0/latest-mac.yml";
const jwtBlob = "https://release-assets.githubusercontent.com/github-production-release-asset/1?jwt=x";

function request(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, DESKTOP_FEED_URL), init);
}

function githubFetch(handlers: Record<string, () => Response>): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = handlers[url];
    if (handler === undefined) return new Response(`unmocked ${url}`, { status: 599 });
    return handler();
  };
}

describe("desktop update feed objects", () => {
  it("accepts channel files and versioned Mac and Windows artifacts", () => {
    expect(desktopUpdateFeedObjectName("/latest-mac.yml")).toBe("latest-mac.yml");
    expect(desktopUpdateFeedObjectName("/latest.yml")).toBe("latest.yml");
    expect(desktopUpdateFeedObjectName("/Enduragent-arm64.dmg")).toBe("Enduragent-arm64.dmg");
    expect(desktopUpdateFeedObjectName("/Enduragent-0.4.0-arm64.zip")).toBe(
      "Enduragent-0.4.0-arm64.zip",
    );
    expect(desktopUpdateFeedObjectName("/Enduragent-0.4.0-arm64.zip.blockmap")).toBe(
      "Enduragent-0.4.0-arm64.zip.blockmap",
    );
    expect(desktopUpdateFeedObjectName("/Enduragent-0.4.0-x64.exe")).toBe("Enduragent-0.4.0-x64.exe");
  });

  it("rejects traversal, encoded hosts, and unknown names", () => {
    expect(desktopUpdateFeedObjectName("/../latest-mac.yml")).toBeUndefined();
    expect(desktopUpdateFeedObjectName("//latest-mac.yml")).toBeUndefined();
    expect(desktopUpdateFeedObjectName("/latest-mac.yml/")).toBeUndefined();
    expect(desktopUpdateFeedObjectName("/enduragent-desktop@0.4.0/latest-mac.yml")).toBeUndefined();
    expect(desktopUpdateFeedObjectName("/secret.txt")).toBeUndefined();
  });

  it("builds the GitHub latest-download URL for an allowed object", () => {
    expect(githubDesktopReleaseObjectUrl("latest-mac.yml")).toBe(githubLatest);
  });
});

describe("desktop update feed handler", () => {
  it("returns GitHub YAML bytes to the client without a redirect", async () => {
    const fetchImpl = githubFetch({
      [githubLatest]: () =>
        new Response(null, { status: 302, headers: { Location: githubTagged } }),
      [githubTagged]: () => new Response(null, { status: 302, headers: { Location: jwtBlob } }),
      [jwtBlob]: () =>
        new Response(yamlBody, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Set-Cookie": "session=1",
            Location: "https://evil.example/",
          },
        }),
    });
    const response = await handleDesktopUpdateFeedRequest(
      request("latest-mac.yml?noCache=abc"),
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.text()).toBe(yamlBody);
  });

  it("forwards a Range GET and returns 206 without leaking GitHub cookies", async () => {
    const zipLatest = `${GITHUB_DESKTOP_RELEASE_FEED_URL}Enduragent-0.4.0-arm64.zip`;
    const zipTagged =
      "https://github.com/yerzhansa/enduragent/releases/download/enduragent-desktop@0.4.0/Enduragent-0.4.0-arm64.zip";
    const zipBlob = "https://release-assets.githubusercontent.com/zip?jwt=y";
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      seen.push(`${init?.method ?? "GET"} ${url} range=${headers.get("range") ?? ""}`);
      if (url === zipLatest || url === zipTagged) {
        const location = url === zipLatest ? zipTagged : zipBlob;
        return new Response(null, { status: 302, headers: { Location: location } });
      }
      if (url === zipBlob) {
        expect(headers.get("range")).toBe("bytes=0-3");
        return new Response("abcd", {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-3/10",
            "Accept-Ranges": "bytes",
            "Set-Cookie": "session=1",
          },
        });
      }
      return new Response(null, { status: 599 });
    };
    const response = await handleDesktopUpdateFeedRequest(
      request("Enduragent-0.4.0-arm64.zip", { headers: { Range: "bytes=0-3" } }),
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("abcd");
    expect(seen).toEqual([
      `GET ${zipLatest} range=bytes=0-3`,
      `GET ${zipTagged} range=bytes=0-3`,
      `GET ${zipBlob} range=bytes=0-3`,
    ]);
  });

  it("returns 404 for an unknown object and 405 for POST", async () => {
    const missing = await handleDesktopUpdateFeedRequest(request("notes.txt"), {
      fetch: githubFetch({}),
    });
    expect(missing.status).toBe(404);
    const posted = await handleDesktopUpdateFeedRequest(request("latest-mac.yml", { method: "POST" }), {
      fetch: githubFetch({}),
    });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns GitHub YAML on HEAD without a body or Location", async () => {
    const fetchImpl = githubFetch({
      [githubLatest]: () =>
        new Response(null, { status: 302, headers: { Location: githubTagged } }),
      [githubTagged]: () => new Response(null, { status: 302, headers: { Location: jwtBlob } }),
      [jwtBlob]: () =>
        new Response(yamlBody, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    });
    const response = await handleDesktopUpdateFeedRequest(
      request("latest-mac.yml", { method: "HEAD" }),
      { fetch: fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("returns 502 when GitHub redirects off githubusercontent hosts", async () => {
    const fetchImpl = githubFetch({
      [githubLatest]: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/latest-mac.yml" },
        }),
    });
    const response = await handleDesktopUpdateFeedRequest(request("latest-mac.yml"), {
      fetch: fetchImpl,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });
});

describe("desktop update feed wiring", () => {
  it("keeps the packaged feed URL in the macOS release workflow", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/desktop-release.yml"),
      "utf8",
    );
    expect(workflow).toContain(`ENDURAGENT_DESKTOP_UPDATE_URL: ${DESKTOP_FEED_URL}`);
    expect(workflow).toContain("Require the public updater feed");
    expect(workflow).toContain(`${DESKTOP_FEED_URL}latest-mac.yml`);
    expect(workflow).toContain(`${DESKTOP_FEED_URL}Enduragent-arm64.dmg`);
    expect(workflow).toContain(
      "https://github.com/$GITHUB_REPOSITORY/releases/latest/download/latest-mac.yml",
    );
    expect(workflow).not.toContain('curl -fsSL "$public_yaml"');
    expect(workflow).not.toContain('curl -fsSIL "${PUBLIC_FEED}');
  });

  it("deploys the public feed Worker with pinned actions and a custom hostname", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/desktop-update-feed.yml"),
      "utf8",
    );
    const wrangler = readFileSync(
      join(repositoryRoot, "tools/desktop-update-feed.wrangler.toml"),
      "utf8",
    );
    expect(workflow).toContain("vars.ENABLE_DESKTOP_UPDATE_FEED == 'true'");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain(
      "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0",
    );
    expect(workflow).toContain(`${DESKTOP_FEED_URL}latest-mac.yml`);
    expect(workflow).not.toContain("curl -fsSL");
    expect(wrangler).toContain('pattern = "updates.enduragent.icu"');
    expect(wrangler).toContain("custom_domain = true");
  });
});

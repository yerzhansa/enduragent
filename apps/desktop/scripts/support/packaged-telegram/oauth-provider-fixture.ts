import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export function syntheticOAuthCredential(sequence = 0, expires = 4_102_444_800_000) {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acceptance-synthetic-account" },
      acceptanceSequence: sequence,
    }),
  ).toString("base64url");
  return {
    type: "oauth" as const,
    access: `synthetic.${payload}.synthetic`,
    refresh: `synthetic-refresh-${sequence}`,
    expires,
    accountId: "acceptance-synthetic-account",
  };
}

export async function startOAuthProviderFixture(options: {
  verifyCallbackOwner: () => Promise<boolean>;
}) {
  let sequence = 0;
  let current = syntheticOAuthCredential();
  let challenge: string | undefined;
  let code: string | undefined;
  let expireLogin = false;
  let rejectModel = false;
  let rejectRefresh = false;
  const observations: { kind: string; sequence: number }[] = [];
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/authorize") {
        const state = url.searchParams.get("state");
        challenge = url.searchParams.get("code_challenge") ?? undefined;
        if (!state || !challenge || code !== undefined || !(await options.verifyCallbackOwner()))
          throw new Error("Invalid authorization request");
        code = `synthetic-authorization-${++sequence}`;
        observations.push({ kind: "authorize", sequence });
        const callback = new URL("http://127.0.0.1:1455/auth/callback");
        callback.searchParams.set("state", state);
        callback.searchParams.set("code", code);
        const completed = await fetch(callback, {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!completed.ok) throw new Error("Production callback rejected authorization");
        json(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST") throw new Error("Unexpected provider request");
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 4 * 1024 * 1024)
          throw new Error("Provider request exceeded fixture limit");
      }
      if (url.pathname === "/oauth/token") {
        const params = new URLSearchParams(body);
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          if (
            code === undefined ||
            params.get("code") !== code ||
            createHash("sha256")
              .update(params.get("code_verifier") ?? "")
              .digest("base64url") !== challenge
          ) {
            throw new Error("Production PKCE exchange mismatch");
          }
          code = undefined;
          challenge = undefined;
        } else if (grant === "refresh_token") {
          if (params.get("refresh_token") !== current.refresh)
            throw new Error("Unexpected refresh credential");
          observations.push({ kind: "refresh", sequence });
          if (rejectRefresh) {
            json(response, 400, { error: "invalid_grant" });
            return;
          }
        } else throw new Error("Unexpected OAuth grant");
        current = syntheticOAuthCredential(++sequence);
        observations.push({ kind: "token", sequence });
        json(response, 200, {
          access_token: current.access,
          refresh_token: current.refresh,
          expires_in: grant === "authorization_code" && expireLogin ? -1 : 3600,
        });
        return;
      }
      if (url.pathname === "/backend-api/codex/responses") {
        if (
          request.headers.authorization !== `Bearer ${current.access}` ||
          request.headers["chatgpt-account-id"] !== current.accountId
        ) {
          throw new Error("Actual coach token did not match the encrypted owner credential");
        }
        const payload: unknown = JSON.parse(body);
        if (
          payload === null ||
          typeof payload !== "object" ||
          !("stream" in payload) ||
          payload.stream !== true
        ) {
          throw new Error("Actual coach did not request a model stream");
        }
        observations.push({ kind: "model", sequence });
        if (rejectModel) {
          rejectModel = false;
          observations.push({ kind: "model-401", sequence });
          json(response, 401, { error: { message: "Synthetic token expired" } });
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        const item = {
          id: "synthetic-message",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Synthetic packaged coach response.", annotations: [] },
          ],
        };
        for (const event of [
          { type: "response.output_item.added", item },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: "synthetic-response",
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      throw new Error("Unexpected provider path");
    } catch {
      observations.push({ kind: "fixture-rejected-request", sequence });
      if (!response.headersSent)
        json(response, 400, { error: "Synthetic fixture rejected request" });
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback fixture failed to bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observations,
    expireNewLogin: () => {
      expireLogin = true;
    },
    rejectNextModel: () => {
      rejectModel = true;
    },
    rejectRefresh: () => {
      rejectRefresh = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

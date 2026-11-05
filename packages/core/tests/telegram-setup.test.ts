import { describe, expect, it, vi } from "vitest";
import {
  deleteTelegramWebhook,
  inspectTelegramCredential,
  type TelegramSetupApi,
} from "../src/channels/telegram-setup.js";

function api(overrides: Partial<TelegramSetupApi> = {}): TelegramSetupApi {
  return {
    getMe: vi.fn(async () => ({ id: 10001, is_bot: true, username: "cycling_test_bot" })),
    getWebhookInfo: vi.fn(async () => ({ url: "" })),
    deleteWebhook: vi.fn(async () => true),
    ...overrides,
  };
}

function dependencies(value: TelegramSetupApi) {
  return { createApi: vi.fn(() => value) };
}

describe("Telegram credential setup", () => {
  it("inspects identity before webhook state and returns an exact redacted ready result", async () => {
    const calls: string[] = [];
    const client = api({
      getMe: vi.fn(async () => {
        calls.push("getMe");
        return { is_bot: true, username: "cycling_test_bot", id: 12345, first_name: "Secret" };
      }),
      getWebhookInfo: vi.fn(async () => {
        calls.push("getWebhookInfo");
        return { url: "", pending_update_count: 7, ip_address: "192.0.2.1" };
      }),
    });
    const deps = dependencies(client);

    await expect(inspectTelegramCredential("12345:secret-token", deps)).resolves.toEqual({
      status: "ready",
      bot: { id: 12345, username: "cycling_test_bot" },
    });
    expect(calls).toEqual(["getMe", "getWebhookInfo"]);
    expect(deps.createApi).toHaveBeenCalledWith("12345:secret-token");
  });

  it("reports a configured webhook without returning its URL", async () => {
    const client = api({
      getWebhookInfo: vi.fn(async () => ({
        url: "https://secret.example.invalid/hook/12345:secret-token",
      })),
    });

    const result = await inspectTelegramCredential("12345:secret-token", dependencies(client));

    expect(result).toEqual({
      status: "webhook-removal-required",
      bot: { id: 10001, username: "cycling_test_bot" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("example.invalid");
  });

  it("classifies only Telegram 401 failures as an invalid token", async () => {
    for (const error of [
      { error_code: 401, description: "12345:secret-token" },
      Object.assign(new Error("unauthorized"), { error_code: 401 }),
    ]) {
      const client = api({
        getMe: vi.fn(async () => {
          throw error;
        }),
      });

      const result = await inspectTelegramCredential("12345:secret-token", dependencies(client));

      expect(result).toEqual({ status: "invalid-token" });
      expect(client.getWebhookInfo).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("secret-token");
    }

    const revokedDuringInspection = api({
      getWebhookInfo: vi.fn(async () => {
        throw { error_code: 401, description: "12345:secret-token" };
      }),
    });
    await expect(
      inspectTelegramCredential("12345:secret-token", dependencies(revokedDuringInspection)),
    ).resolves.toEqual({ status: "invalid-token" });
  });

  it("maps transport, server, malformed, and factory failures to one redacted unavailable result", async () => {
    const unavailable = {
      status: "unavailable",
      errorCode: "telegram-validation-failed",
    } as const;
    const cases = [
      () =>
        inspectTelegramCredential(
          "12345:secret-token",
          dependencies(
            api({
              getMe: vi.fn(async () => {
                throw new Error("network failed for 12345:secret-token");
              }),
            }),
          ),
        ),
      () =>
        inspectTelegramCredential(
          "12345:secret-token",
          dependencies(api({ getWebhookInfo: vi.fn(async () => ({ pending_update_count: 0 })) })),
        ),
      () =>
        inspectTelegramCredential(
          "12345:secret-token",
          dependencies(
            api({
              getWebhookInfo: vi.fn(async () => {
                throw new Error("transport exposed 12345:secret-token");
              }),
            }),
          ),
        ),
      () =>
        inspectTelegramCredential("12345:secret-token", {
          createApi() {
            throw new Error("factory exposed 12345:secret-token");
          },
        }),
    ];

    for (const inspect of cases) {
      const result = await inspect();
      expect(result).toEqual(unavailable);
      expect(JSON.stringify(result)).not.toContain("secret-token");
    }
  });

  it("rejects a non-bot or unsafe username without probing webhook state", async () => {
    for (const me of [
      { is_bot: false, username: "cycling_test_bot" },
      { is_bot: true, username: "https://secret.example.invalid" },
      { is_bot: true },
    ]) {
      const client = api({ getMe: vi.fn(async () => me) });

      await expect(
        inspectTelegramCredential("12345:secret-token", dependencies(client)),
      ).resolves.toEqual({ status: "invalid-token" });
      expect(client.getWebhookInfo).not.toHaveBeenCalled();
    }
  });

  it("deletes without dropping pending updates, then re-inspects on the same API client", async () => {
    const calls: string[] = [];
    const client = api({
      deleteWebhook: vi.fn(async (options) => {
        calls.push(`delete:${String(options.drop_pending_updates)}`);
        return true;
      }),
      getMe: vi.fn(async () => {
        calls.push("getMe");
        return { id: 10001, is_bot: true, username: "cycling_test_bot" };
      }),
      getWebhookInfo: vi.fn(async () => {
        calls.push("getWebhookInfo");
        return { url: "" };
      }),
    });
    const deps = dependencies(client);

    await expect(deleteTelegramWebhook("12345:secret-token", deps)).resolves.toEqual({
      status: "ready",
      bot: { id: 10001, username: "cycling_test_bot" },
    });
    expect(calls).toEqual(["delete:false", "getMe", "getWebhookInfo"]);
    expect(client.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false });
    expect(deps.createApi).toHaveBeenCalledOnce();
  });

  it("returns the reinspection result when a webhook remains configured", async () => {
    const client = api({ getWebhookInfo: vi.fn(async () => ({ url: "https://hook.invalid" })) });

    await expect(
      deleteTelegramWebhook("12345:secret-token", dependencies(client)),
    ).resolves.toEqual({
      status: "webhook-removal-required",
      bot: { id: 10001, username: "cycling_test_bot" },
    });
  });

  it("redacts delete failures and does not inspect after a failed deletion", async () => {
    const client = api({
      deleteWebhook: vi.fn(async () => {
        throw { error_code: 500, description: "12345:secret-token" };
      }),
    });

    const result = await deleteTelegramWebhook("12345:secret-token", dependencies(client));

    expect(result).toEqual({
      status: "unavailable",
      errorCode: "telegram-validation-failed",
    });
    expect(client.getMe).not.toHaveBeenCalled();
    expect(client.getWebhookInfo).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("reports a malformed proxy setting as unavailable instead of failing to load", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://[bad");
    vi.resetModules();
    try {
      const setup = await import("../src/channels/telegram-setup.js");
      await expect(setup.inspectTelegramCredential("123:test")).resolves.toEqual({
        status: "unavailable",
        errorCode: "telegram-validation-failed",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

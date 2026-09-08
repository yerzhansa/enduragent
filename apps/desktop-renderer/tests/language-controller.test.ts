import type { CoachClient } from "@enduragent/coach-client";
import type { LanguageTag } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createLanguageSettingsController,
  type LanguagePreferenceViewState,
} from "../src/settings/language-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  const client: Pick<CoachClient, "call"> = {
    async call() {
      throw new Error("Unexpected RPC call");
    },
  };
  const call = vi.spyOn(client, "call");
  const getClient = vi.fn(async () => client);
  const states: LanguagePreferenceViewState[] = [];
  const controller = createLanguageSettingsController({
    clients: { getClient },
    view: { render: (state) => states.push(state) },
  });
  return { call, getClient, states, controller };
}

describe("language settings controller", () => {
  it("loads once on start and adopts only the authoritative save result", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ value: "it" });
    await Promise.all([f.controller.start(), f.controller.start()]);
    expect(f.call).toHaveBeenCalledExactlyOnceWith("getLanguagePreference", {});
    const saved = deferred<{ value: LanguageTag | null }>();
    f.call.mockReturnValueOnce(saved.promise);
    const saving = f.controller.set("fr");
    await vi.waitFor(() =>
      expect(f.call).toHaveBeenCalledWith("setLanguagePreference", { value: "fr" }),
    );
    expect(f.states.at(-1)).toEqual({ status: "saving", value: "it" });
    saved.resolve({ value: "es" });
    await saving;
    expect(f.states.at(-1)).toEqual({ status: "ready", value: "es" });
    f.controller.dispose();
  });

  it("retains the confirmed selection on failed save and allows clearing to Automatic", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ value: "ja" });
    await f.controller.start();
    f.call.mockRejectedValueOnce(new Error("save unavailable"));
    await f.controller.set("fr");
    expect(f.states.at(-1)).toEqual({ status: "unavailable", value: "ja" });
    f.call.mockResolvedValueOnce({ value: null });
    await f.controller.set(null);
    expect(f.call).toHaveBeenLastCalledWith("setLanguagePreference", { value: null });
    expect(f.states.at(-1)).toEqual({ status: "ready", value: null });
    f.controller.dispose();
  });

  it("re-reads from the current client after reconnect", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ value: "en" });
    await f.controller.start();
    const reconnected = fixture();
    const call = reconnected.call.mockResolvedValue({ value: "de" });
    f.getClient.mockImplementation(reconnected.getClient);
    await f.controller.refresh();
    expect(call).toHaveBeenCalledExactlyOnceWith("getLanguagePreference", {});
    expect(f.states.at(-1)).toEqual({ status: "ready", value: "de" });
    f.controller.dispose();
  });

  it("serializes writes and reconnect reads behind pending writes", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ value: "en" });
    await f.controller.start();
    const saved = deferred<{ value: LanguageTag | null }>();
    f.call
      .mockReturnValueOnce(saved.promise)
      .mockResolvedValueOnce({ value: "de" })
      .mockResolvedValueOnce({ value: "it" });
    const first = f.controller.set("fr");
    const second = f.controller.set("de");
    const refresh = f.controller.refresh();
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
    saved.resolve({ value: "fr" });
    await Promise.all([first, second, refresh]);
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      "getLanguagePreference",
      "setLanguagePreference",
      "setLanguagePreference",
      "getLanguagePreference",
    ]);
    expect(f.states.at(-1)).toEqual({ status: "ready", value: "it" });
    f.controller.dispose();
  });

  it("retains the last value when a refresh fails", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ value: "ko" });
    await f.controller.start();
    f.call.mockRejectedValueOnce(new Error("disconnected"));
    await f.controller.refresh();
    expect(f.states.at(-1)).toEqual({ status: "unavailable", value: "ko" });
    f.controller.dispose();
  });

  it("ignores pending results and queued operations after disposal", async () => {
    const f = fixture();
    const loaded = deferred<{ value: LanguageTag | null }>();
    f.call.mockReturnValueOnce(loaded.promise);
    const loading = f.controller.start();
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    const saving = f.controller.set("fr");
    f.controller.dispose();
    const before = [...f.states];
    loaded.resolve({ value: "en" });
    await Promise.all([loading, saving, f.controller.refresh()]);
    expect(f.states).toEqual(before);
    expect(f.call).toHaveBeenCalledOnce();
  });
});

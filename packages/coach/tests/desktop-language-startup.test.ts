import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { getPreferredSystemLanguages: vi.fn(() => ["fr-BE", "en-US"]) },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock("../../../apps/desktop/node_modules/electron/index.js", () => electron);

import {
  forkAppSupervisedDaemon,
  isUtilityStartFrame,
} from "../../../apps/desktop/src/main/supervisor.js";

const frame = {
  type: "start",
  homeRoot: "/synthetic/home",
  appVersion: "2026.8.8",
  preferredLanguages: ["fr-BE", "en-US"],
};

describe("desktop language startup", () => {
  it("validates the optional OS hint array and preserves exact frame validation", () => {
    expect(isUtilityStartFrame(frame)).toBe(true);
    expect(isUtilityStartFrame({ ...frame, preferredLanguages: [] })).toBe(true);
    expect(isUtilityStartFrame({ ...frame, handoffCapability: "x".repeat(43) })).toBe(true);
    expect(isUtilityStartFrame({ ...frame, preferredLanguages: undefined })).toBe(true);
    for (const preferredLanguages of [null, "fr", [3], [""], ["x".repeat(129)]]) {
      expect(isUtilityStartFrame({ ...frame, preferredLanguages })).toBe(false);
    }
    expect(isUtilityStartFrame({ ...frame, extra: true })).toBe(false);
  });

  it("posts Electron's OS hints with the daemon startup frame", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 91, postMessage: vi.fn() });
    electron.utilityProcess.fork.mockReturnValue(child);
    const starting = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon.js",
      homeRoot: frame.homeRoot,
      appVersion: frame.appVersion,
    });
    child.emit("spawn");
    const daemon = await starting;
    expect(child.postMessage).toHaveBeenCalledWith(frame);
    child.emit("exit", 0);
    await expect(daemon.exited).resolves.toEqual({ exitCode: 0 });
  });
});

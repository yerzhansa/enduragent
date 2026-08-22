import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEYCHAIN_BINDING_BUILD_DIRECTORY } from "../scripts/build-keychain-binding.mjs";
import { KEYCHAIN_BINDING_ASAR_PATH } from "../scripts/package-inventory.mjs";
import {
  KEYCHAIN_BINDING_ASAR_DIRECTORY,
  KEYCHAIN_BINDING_DEVELOPMENT_DIRECTORY,
  KEYCHAIN_BINDING_FILE_NAME,
  resolveKeychainBindingPath,
} from "../src/main/keychain-binding-path.js";

const packaged = {
  platform: "darwin" as NodeJS.Platform,
  packaged: true,
  resourcesPath: "/Applications/Enduragent.app/Contents/Resources",
  applicationPath: "/Applications/Enduragent.app/Contents/Resources/app.asar",
};

const development = {
  platform: "darwin" as NodeJS.Platform,
  packaged: false,
  resourcesPath: "/opt/electron/resources",
  applicationPath: "/repository/apps/desktop",
};

describe("keychain binding path", () => {
  it("agrees with the package and build authorities", () => {
    expect(join(KEYCHAIN_BINDING_ASAR_DIRECTORY, KEYCHAIN_BINDING_FILE_NAME)).toBe(
      KEYCHAIN_BINDING_ASAR_PATH,
    );
    expect(KEYCHAIN_BINDING_DEVELOPMENT_DIRECTORY).toBe(KEYCHAIN_BINDING_BUILD_DIRECTORY);
  });

  it("resolves the packaged binding only under app.asar.unpacked", () => {
    expect(resolveKeychainBindingPath(packaged)).toBe(
      "/Applications/Enduragent.app/Contents/Resources/app.asar.unpacked/native/keychain-binding.node",
    );
    expect(resolveKeychainBindingPath(development)).toBe(
      "/repository/apps/desktop/dist/keychain-binding/keychain-binding.node",
    );
  });

  it.each(["win32", "linux"] as const)("returns nothing on %s", (platform) => {
    expect(resolveKeychainBindingPath({ ...packaged, platform })).toBeUndefined();
    expect(resolveKeychainBindingPath({ ...development, platform })).toBeUndefined();
  });

  it("rejects a relative active root", () => {
    expect(resolveKeychainBindingPath({ ...packaged, resourcesPath: "Resources" })).toBeUndefined();
    expect(
      resolveKeychainBindingPath({ ...development, applicationPath: "apps/desktop" }),
    ).toBeUndefined();
  });
});

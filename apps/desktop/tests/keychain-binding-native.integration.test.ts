import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildKeychainBinding,
  KEYCHAIN_BINDING_MINIMUM_MACOS,
  keychainBindingBuildPath,
  keychainBindingCompilerAvailable,
} from "../scripts/build-keychain-binding.mjs";
import {
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  createKeychainBindingTransport,
} from "../src/main/keychain-binding.js";

const COMPILE_TIMEOUT_MS = 300_000;
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPartitionDescription =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
  '<plist version="1.0"><dict><key>Partitions</key><array>' +
  "<string>teamid:FA494ACVTF</string></array></dict></plist>";
const alternatePartitionDescription = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Partitions</key>
    <array>
      <string>teamid:FA494ACVTF</string>
    </array>
  </dict>
</plist>`;
let root = "";
let parserHarness = "";

function plistDictionary(contents: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${contents}</dict></plist>`;
}

function harnessStatus(...arguments_: string[]) {
  const result = spawnSync(parserHarness, arguments_, {
    encoding: "utf8",
    timeout: COMPILE_TIMEOUT_MS,
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`partition description harness stopped with ${result.signal}`);
  }
  return result.status;
}

function partitionDescriptionStatus(...descriptions: string[]) {
  return harnessStatus("descriptions", ...descriptions);
}

function partitionAclStatus(
  authorization: "exact" | "wrong" | "extra",
  applications: "null" | "empty" | "populated",
  prompt: "zero" | "nonzero",
) {
  return harnessStatus("acl", authorization, applications, prompt, canonicalPartitionDescription);
}

function accessAclStatus(
  ownerAuthorization: "exact" | "extra",
  ownerApplications: "null" | "empty" | "populated",
  ownerCount: "missing" | "single" | "duplicate",
  partitionCount: "missing" | "single" | "duplicate",
  unrelated: "none" | "default" | "any" | "change-owner",
) {
  return harnessStatus(
    "access",
    ownerAuthorization,
    ownerApplications,
    ownerCount,
    partitionCount,
    unrelated,
    canonicalPartitionDescription,
  );
}

describe.skipIf(process.platform !== "darwin" || !keychainBindingCompilerAvailable())(
  "keychain native binding",
  () => {
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "enduragent-keychain-binding-"));
      await cp(join(desktopRoot, "native"), join(root, "native"), { recursive: true });
      await buildKeychainBinding(root);
      parserHarness = join(root, "partition-description-harness");
      const compile = spawnSync(
        "xcrun",
        [
          "clang++",
          join(root, "native/keychain-binding/partition-description-harness.mm"),
          join(root, "native/keychain-binding/partition-description.mm"),
          "-std=c++20",
          "-O2",
          "-arch",
          "arm64",
          `-mmacosx-version-min=${KEYCHAIN_BINDING_MINIMUM_MACOS}`,
          "-framework",
          "CoreFoundation",
          "-framework",
          "Security",
          "-o",
          parserHarness,
        ],
        { encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
      );
      if (compile.error !== undefined) throw compile.error;
      if (compile.status !== 0 || compile.signal !== null) {
        throw new Error(compile.stderr || "partition description harness compilation failed");
      }
    }, COMPILE_TIMEOUT_MS);

    afterAll(async () => {
      if (root !== "") await rm(root, { recursive: true, force: true });
    });

    it("refuses ordinary Node before every Keychain operation", async () => {
      const transport = createKeychainBindingTransport({
        bindingPath: keychainBindingBuildPath(root),
      });
      for (const op of ["probe", "read-key", "create-key", "delete-key"] as const) {
        await expect(
          transport.send({ op, service: KEYCHAIN_CREDENTIAL_SERVICE_DEV }),
        ).resolves.toEqual({ ok: false, code: "not-team-signed" });
      }
    });

    it("pins promptless persisted-key validation and secure erasure", async () => {
      const source = await readFile(
        join(desktopRoot, "native/keychain-binding/keychain-binding.mm"),
        "utf8",
      );
      const readiness = source.slice(
        source.indexOf("bool ReadyForKeychain"),
        source.indexOf("napi_value Probe"),
      );
      const creation = source.slice(
        source.indexOf("napi_value CreateKey"),
        source.indexOf("napi_value DeleteKey"),
      );
      const accessConstructionStart = source.indexOf("SecAccessRef MakeAccess");
      const accessConstruction = source.slice(
        accessConstructionStart,
        source.indexOf("PartitionInspection InspectAccess", accessConstructionStart),
      );
      expect(readiness.indexOf("InteractionDisabled()")).toBeLessThan(
        readiness.indexOf("TrustedHost()"),
      );
      expect(accessConstruction).toContain(
        "acceptable = IsExpectedOwnerAcl(authorizations, applications)",
      );
      expect(accessConstruction.indexOf("IsExpectedOwnerAcl")).toBeLessThan(
        accessConstruction.indexOf("SecACLSetContents"),
      );
      expect(accessConstruction).toContain(
        "InspectAccess(access) != PartitionInspection::kPresent",
      );
      expect(creation.indexOf("InspectPartition(")).toBeLessThan(
        creation.indexOf("SecKeychainItemCopyContent"),
      );
      expect(creation.indexOf("SecKeychainItemCopyContent")).toBeLessThan(
        creation.indexOf("SecKeychainItemFreeContent"),
      );
      expect(creation.indexOf("SecKeychainItemFreeContent")).toBeLessThan(
        creation.indexOf("napi_create_buffer_copy"),
      );
      expect(creation).toContain("persistedLength == static_cast<UInt32>(material.size())");
      expect(creation).toContain("timingsafe_bcmp");
      expect(creation).not.toContain("SecItemDelete");
      expect(source).toContain("#define __STDC_WANT_LIB_EXT1__ 1");
      expect(source).toContain("memset_s(material.data(), material.size(), 0, material.size())");
      expect(source).not.toContain("explicit_bzero");
      expect(source).not.toContain("material.fill");
    });

    it("accepts equivalent exact partition property lists", () => {
      expect(partitionDescriptionStatus(canonicalPartitionDescription)).toBe(0);
      expect(partitionDescriptionStatus(alternatePartitionDescription)).toBe(0);
    });

    it("accepts only exact persisted partition ACL fields", () => {
      expect(partitionAclStatus("exact", "null", "zero")).toBe(0);
      expect(partitionAclStatus("extra", "null", "zero")).toBe(1);
      expect(partitionAclStatus("wrong", "null", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "empty", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "populated", "zero")).toBe(1);
      expect(partitionAclStatus("exact", "null", "nonzero")).toBe(1);
    });

    it("accepts one protected owner with one exact partition ACL", () => {
      expect(accessAclStatus("exact", "empty", "single", "single", "none")).toBe(0);
      expect(accessAclStatus("exact", "empty", "single", "single", "default")).toBe(0);
    });

    it("rejects an unsafe or ambiguous owner ACL", () => {
      expect(accessAclStatus("exact", "empty", "missing", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "empty", "duplicate", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "null", "single", "single", "none")).toBe(1);
      expect(accessAclStatus("exact", "populated", "single", "single", "none")).toBe(1);
      expect(accessAclStatus("extra", "empty", "single", "single", "none")).toBe(1);
    });

    it("rejects ambiguous partitions and unrestricted mutation authority", () => {
      expect(accessAclStatus("exact", "empty", "single", "missing", "none")).toBe(1);
      expect(accessAclStatus("exact", "empty", "single", "duplicate", "none")).toBe(1);
      expect(accessAclStatus("exact", "empty", "single", "single", "any")).toBe(1);
      expect(accessAclStatus("exact", "empty", "single", "single", "change-owner")).toBe(1);
    });

    it("rejects malformed and structurally invalid property lists", () => {
      const rejected = [
        "teamid:FA494ACVTF",
        '<?xml version="1.0"?><plist><dict>',
        '<?xml version="1.0"?><plist version="1.0"><array><string>teamid:FA494ACVTF</string></array></plist>',
        plistDictionary(""),
        plistDictionary("<key>Partitions</key><string>teamid:FA494ACVTF</string>"),
        plistDictionary("<key>Partitions</key><array></array>"),
        plistDictionary("<key>Partitions</key><array><integer>1</integer></array>"),
      ];
      for (const description of rejected) {
        expect(partitionDescriptionStatus(description)).toBe(1);
      }
    });

    it("rejects extra keys and extra, missing, or wrong partitions", () => {
      const rejected = [
        plistDictionary(
          "<key>Partitions</key><array><string>teamid:FA494ACVTF</string></array>" +
            "<key>Extra</key><string>teamid:FA494ACVTF</string>",
        ),
        plistDictionary("<key>Partitions</key><array><string>teamid:OTHER</string></array>"),
        plistDictionary(
          "<key>Partitions</key><array><string>teamid:FA494ACVTF</string>" +
            "<string>teamid:OTHER</string></array>",
        ),
      ];
      for (const description of rejected) {
        expect(partitionDescriptionStatus(description)).toBe(1);
      }
    });

    it("rejects duplicate partition dictionary keys", () => {
      const expected = "<key>Partitions</key><array><string>teamid:FA494ACVTF</string></array>";
      const wrong = "<key>Partitions</key><array><string>teamid:OTHER</string></array>";
      expect(partitionDescriptionStatus(plistDictionary(expected + expected))).toBe(1);
      expect(partitionDescriptionStatus(plistDictionary(expected + wrong))).toBe(1);
    });

    it("rejects zero or multiple partition-authorized ACL descriptions", () => {
      expect(partitionDescriptionStatus()).toBe(1);
      expect(
        partitionDescriptionStatus(canonicalPartitionDescription, alternatePartitionDescription),
      ).toBe(1);
    });
  },
);

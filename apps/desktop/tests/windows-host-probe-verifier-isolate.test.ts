import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { loadRetainedProbeVerifier } from "../scripts/windows-host-falsifier/probe-verifier-isolate.mjs";

async function sources() {
  const [registrySourceBytes, contractSourceBytes] = await Promise.all([
    readFile(new URL("../scripts/windows-host-falsifier/probe-registry.mjs", import.meta.url)),
    readFile(new URL("../scripts/windows-host-falsifier/probe-contract.mjs", import.meta.url)),
  ]);
  return { registrySourceBytes, contractSourceBytes };
}

async function nativeClosureSources() {
  const [retained, nativeClientSourceBytes, nativeManifestDigestSourceBytes] = await Promise.all([
    sources(),
    readFile(new URL("../scripts/windows-host-falsifier/native-client.mjs", import.meta.url)),
    readFile(
      new URL("../scripts/windows-host-falsifier/native-manifest-digest.mjs", import.meta.url),
    ),
  ]);
  return { ...retained, nativeClientSourceBytes, nativeManifestDigestSourceBytes };
}

describe("retained Windows probe verifier isolate", () => {
  it("evaluates the exact retained registry and contract source bytes", async () => {
    const retained = await sources();
    const verifier = await loadRetainedProbeVerifier(retained);
    await expect(
      verifier.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).resolves.toMatchObject({
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      mechanismId: "win32-file-identity-home-key-v1",
    });
    const transcriptFacts = await verifier.getTranscriptFactDefinition(
      "F-01",
      "f01-ordinary-absolute-path",
    );
    expect(transcriptFacts).toMatchObject({
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      transcriptKind: "windows-host-probe-native-transcript",
      commands: [{ commandId: "home-identity" }],
    });
    expect(transcriptFacts.commands[0].factKeys).toContain("credentialReadAttempted");
    expect(Object.isFrozen(transcriptFacts)).toBe(true);
    expect(Object.isFrozen(transcriptFacts.commands)).toBe(true);
    expect(Object.isFrozen(transcriptFacts.commands[0].factKeys)).toBe(true);

    const restartFacts = await verifier.getTranscriptFactDefinition(
      "F-01",
      "f01-restart-stability",
    );
    expect(restartFacts.variantId).not.toBe(transcriptFacts.variantId);
    expect(restartFacts.mappingSha256).not.toBe(transcriptFacts.mappingSha256);

    const alteredRegistry = Buffer.from(
      retained.registrySourceBytes
        .toString("utf8")
        .replace("win32-file-identity-home-key-v1", "isolated-file-identity-home-key-v1"),
      "utf8",
    );
    const altered = await loadRetainedProbeVerifier({
      ...retained,
      registrySourceBytes: alteredRegistry,
    });
    await expect(
      altered.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).resolves.toMatchObject({ mechanismId: "isolated-file-identity-home-key-v1" });

    const registrySource = retained.registrySourceBytes.toString("utf8");
    const alteredFactSource = registrySource.replace(
      '"credentialReadAttempted"',
      '"credentialReadAttemptedFromRetainedSource"',
    );
    expect(alteredFactSource).not.toBe(registrySource);
    const alteredFacts = await loadRetainedProbeVerifier({
      ...retained,
      registrySourceBytes: Buffer.from(alteredFactSource, "utf8"),
    });
    await expect(
      alteredFacts.getTranscriptFactDefinition("F-01", "f01-ordinary-absolute-path"),
    ).resolves.toMatchObject({
      commands: [
        {
          commandId: "home-identity",
          factKeys: expect.arrayContaining(["credentialReadAttemptedFromRetainedSource"]),
        },
      ],
    });
  });

  it("rejects an isolate source that imports anything outside the allowlisted closure", async () => {
    const retained = await sources();
    const injected = Buffer.from(
      `import "./unretained-module.mjs";\n${retained.registrySourceBytes.toString("utf8")}`,
      "utf8",
    );
    const verifier = await loadRetainedProbeVerifier({
      ...retained,
      registrySourceBytes: injected,
    });
    await expect(
      verifier.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).rejects.toMatchObject({ code: "VERIFIER_ISOLATE_EXECUTION" });

    const builtinInjected = await loadRetainedProbeVerifier({
      ...retained,
      registrySourceBytes: Buffer.from(
        `import "node:fs";\n${retained.registrySourceBytes.toString("utf8")}`,
        "utf8",
      ),
    });
    await expect(
      builtinInjected.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).rejects.toMatchObject({ code: "VERIFIER_ISOLATE_EXECUTION" });

    const ambientProcessInjected = await loadRetainedProbeVerifier({
      ...retained,
      registrySourceBytes: Buffer.from(
        `process.cwd();\n${retained.registrySourceBytes.toString("utf8")}`,
        "utf8",
      ),
    });
    await expect(
      ambientProcessInjected.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).rejects.toMatchObject({ code: "VERIFIER_ISOLATE_EXECUTION" });
  });

  it("loads the exact retained native validator closure and rejects an incomplete closure", async () => {
    const retained = await nativeClosureSources();
    const verifier = await loadRetainedProbeVerifier(retained);
    await expect(
      verifier.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).resolves.toMatchObject({ mechanismId: "win32-file-identity-home-key-v1" });

    const brokerValidationInjected = await loadRetainedProbeVerifier({
      ...retained,
      nativeClientSourceBytes: Buffer.concat([
        retained.nativeClientSourceBytes,
        Buffer.from("\nvalidateProbeBrokerEnrollment({});\n", "utf8"),
      ]),
    });
    await expect(
      brokerValidationInjected.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).rejects.toMatchObject({
      code: "VERIFIER_ISOLATE_EXECUTION",
      message: expect.stringContaining("./broker/mailbox-protocol.mjs is unavailable"),
    });

    const { nativeManifestDigestSourceBytes: _omitted, ...missingHelper } = retained;
    await expect(loadRetainedProbeVerifier(missingHelper)).rejects.toMatchObject({
      code: "VERIFIER_ISOLATE_SOURCE",
    });
  });

  it("gives the retained native validator a drive-qualified Windows file URL", async () => {
    const retained = await nativeClosureSources();
    const expectedWindowsPath = String.raw`C:\retained\native-client.mjs`;
    const nativeClientSourceBytes = Buffer.concat([
      retained.nativeClientSourceBytes,
      Buffer.from(
        `\nif (fileURLToPath(import.meta.url, { windows: true }) !== ${JSON.stringify(expectedWindowsPath)}) throw new Error("retained native validator URL is not Windows-absolute");\n`,
        "utf8",
      ),
    ]);
    const verifier = await loadRetainedProbeVerifier({
      ...retained,
      nativeClientSourceBytes,
    });

    await expect(
      verifier.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).resolves.toMatchObject({ mechanismId: "win32-file-identity-home-key-v1" });
  });

  it("rejects an unallowlisted import in the retained native manifest digest helper", async () => {
    const retained = await nativeClosureSources();
    const verifier = await loadRetainedProbeVerifier({
      ...retained,
      nativeManifestDigestSourceBytes: Buffer.from(
        `import "node:fs";\n${retained.nativeManifestDigestSourceBytes.toString("utf8")}`,
        "utf8",
      ),
    });
    await expect(
      verifier.getDefinition("F-01", "f01-ordinary-absolute-path"),
    ).rejects.toMatchObject({
      code: "VERIFIER_ISOLATE_EXECUTION",
      message: expect.stringContaining(
        "native manifest digest helper imported an unallowlisted module: node:fs",
      ),
    });
  });
});

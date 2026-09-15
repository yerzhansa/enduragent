import { realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import certificates from "../src/certificates/apple-roots.json" with { type: "json" };
import { runProof as run, writeProof } from "./live-proof.js";

export function createProofVerifier(
  roots = [Buffer.from(certificates.G2, "base64"), Buffer.from(certificates.G3, "base64")],
) {
  return new SignedDataVerifier(roots, true, Environment.SANDBOX, "icu.enduragent.app");
}

export function runProof(
  input: Record<string, string | undefined>,
  transport: typeof fetch = fetch,
) {
  return run(input, transport, createProofVerifier());
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await writeProof(() => runProof(process.env));
}

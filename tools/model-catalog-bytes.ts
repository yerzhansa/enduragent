export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export async function sha256(bytes: Uint8Array): Promise<{
  readonly hex: string;
  readonly contentDigest: string;
}> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput.buffer));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const binary = Array.from(digest, (byte) => String.fromCharCode(byte)).join("");
  return Object.freeze({ hex, contentDigest: `sha-256=:${btoa(binary)}:` });
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

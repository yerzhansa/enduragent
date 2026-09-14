export const Headers = globalThis.Headers;

export default function workerFetch(...args: Parameters<typeof globalThis.fetch>) {
  return globalThis.fetch(...args);
}

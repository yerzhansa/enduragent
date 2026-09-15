declare module "cloudflare:test" {
  export type D1Migration = { name: string; queries: string[] };
  export const env: import("./env.js").Env & { TEST_MIGRATIONS: D1Migration[] };
  export function applyD1Migrations(
    db: import("./env.js").D1Database,
    migrations: D1Migration[],
  ): Promise<void>;
  export function runInDurableObject<R>(
    stub: import("./env.js").DurableObjectStub,
    callback: (
      instance: unknown,
      state: import("./env.js").DurableObjectState,
    ) => R | Promise<R>,
  ): Promise<R>;
}

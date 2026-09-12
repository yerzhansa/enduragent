declare module "cloudflare:test" {
  export const env: import("./env.js").Env;
  export function runInDurableObject<R>(
    stub: import("./env.js").DurableObjectStub,
    callback: (
      instance: unknown,
      state: import("./env.js").DurableObjectState,
    ) => R | Promise<R>,
  ): Promise<R>;
}

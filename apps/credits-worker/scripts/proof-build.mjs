import { build } from "esbuild";
import { createRequire } from "node:module";
import { realpath, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const verifier = await realpath(
  require.resolve("@apple/app-store-server-library/dist/jws_verification.js"),
);
const wrapper = resolve(here, "proof-ocsp.ts");

export async function buildProof({ stdin, plugins = [] } = {}) {
  let verifierImports = 0;
  const result = await build({
    ...(stdin
      ? { stdin: { contents: stdin, resolveDir: here, loader: "ts" } }
      : { entryPoints: [resolve(here, "proof-entry.ts")] }),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    banner: {
      js: 'import { createRequire as proofRequire } from "node:module"; const require = proofRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "apple-proof-ocsp",
        setup(builder) {
          builder.onResolve({ filter: /^node-fetch$/ }, (args) => {
            if (args.importer !== verifier) return;
            verifierImports += 1;
            return { path: wrapper };
          });
        },
      },
      ...plugins,
    ],
  });
  if (verifierImports !== 1) throw new Error("pinned verifier transport import changed");
  return { ...result, verifierImports };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildProof();
  const destination = resolve(here, "../dist/live-proof.mjs");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, result.outputFiles[0].contents);
}

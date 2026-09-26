import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function doctor(repo) {
 assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or newer is required');
 const binary = join(repo, 'packages/cycling-coach/dist/index.js');
 assert.ok(existsSync(binary), 'Build cycling-coach before driving');
 const built = statSync(binary).mtimeMs;
 const packages = new Map(readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter(x => x.isDirectory()).flatMap(x => {
  const dir = join(repo, 'packages', x.name);
  if (!existsSync(join(dir, 'package.json'))) return [];
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return [[manifest.name, { dir, manifest }]];
 }));
 const checked = new Set();
 function fresh(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
   for (const child of readdirSync(path)) fresh(join(path, child));
  } else assert.ok(statSync(path).mtimeMs <= built, `Rebuild npm output; newer input ${path.slice(repo.length + 1)}`);
 }
 function visit(name) {
  if (checked.has(name)) return;
  checked.add(name);
  const entry = packages.get(name);
  assert.ok(entry, `Missing workspace package ${name}`);
  for (const input of ['src', 'skills', 'catalogs', 'scripts', 'SOUL.md', 'package.json', 'tsup.config.ts', 'tsconfig.json']) fresh(join(entry.dir, input));
  for (const [dependency, version] of Object.entries({ ...entry.manifest.dependencies, ...entry.manifest.devDependencies })) {
   if (version.startsWith('workspace:')) visit(dependency);
  }
 }
 visit('cycling-coach');
 fresh(join(repo, 'pnpm-lock.yaml'));
 const require = createRequire(join(repo, 'package.json'));
 require.resolve('@sinonjs/fake-timers');
 assert.ok(readFileSync(binary, 'utf8').includes('aggregate-v1'), 'This checkout does not contain npm workout change sets');
 console.log('DOCTOR: ready to drive built npm fixture');
 return binary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const repo = resolve(process.argv.find(x => x.startsWith('--repo='))?.slice(7) ?? process.cwd());
 try { doctor(repo); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

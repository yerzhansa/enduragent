import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.every(value => value.startsWith('--repo=') || value.startsWith('--manifest=')), 'Use --repo=<checkout> and optional --manifest=<file>');
const repo = resolve(args.find(value => value.startsWith('--repo='))?.slice(7) ?? process.cwd());
const manifestPath = resolve(args.find(value => value.startsWith('--manifest='))?.slice(11) ?? join(skill, 'references/features/coverage.json'));
const map = JSON.parse(readFileSync(manifestPath, 'utf8'));
const inventory = JSON.parse(readFileSync(map.source_inventory, 'utf8'));
assert.equal(map.schema_version, 1);
const expected = [...inventory.features, ...inventory.knowledge_topics, ...inventory.diagnostic_metrics].map(entry => entry.id).sort();
const actual = map.features.flatMap(feature => feature.inventory_ids).sort();
assert.equal(new Set(actual).size, actual.length, 'An inventory ID appears on multiple feature pages');
assert.deepEqual(actual, expected, 'Every source inventory ID must have exactly one feature page');
assert.equal(new Set(map.features.map(feature => feature.slug)).size, map.features.length, 'Duplicate feature slug');
assert.deepEqual(readdirSync(join(skill, 'references/features')).filter(name => name.endsWith('.md') && name !== 'README.md').sort(), map.features.map(feature => feature.page).sort(), 'Feature directory and manifest must agree');
const index = readFileSync(join(skill, 'references/features/README.md'), 'utf8');
const headings = ['## Sub-features', '## How to get to it (user POV)', '## Driving it with npm-coach verification', '## Gotchas'];
let pathsChecked = 0;
for (const feature of map.features) {
  assert.match(feature.page, /^[a-z0-9-]+\.md$/);
  const page = readFileSync(join(skill, 'references/features', feature.page), 'utf8');
  assert.deepEqual(page.match(/^## .+$/gm), headings, `${feature.slug}: feature page sections`);
  assert.ok(index.includes(`](${feature.page})`), `${feature.slug}: missing index link`);
  const inventoryTable = page.split('| Inventory ID | Capability |')[1]?.split('\n\n')[0] ?? '';
  const pageIds = [...inventoryTable.matchAll(/^\| ([NCTWKM]\d{2}) \|/gm)].map(match => match[1]).sort();
  assert.deepEqual(pageIds, [...feature.inventory_ids].sort(), `${feature.slug}: page IDs drifted`);
  assert.ok(feature.source_paths.length > 0 && feature.test_files.length > 0, `${feature.slug}: missing source or executor`);
  for (const path of [...feature.source_paths, ...feature.test_files]) {
    assert.ok(!path.includes('..') && !path.startsWith('/'), 'Source paths must stay within the selected checkout');
    assert.ok(existsSync(join(repo, path)), `${feature.slug}: missing ${path}`);
    pathsChecked += 1;
  }
}
const commands = [...readFileSync(join(repo, 'packages/core/src/channels/telegram.ts'), 'utf8').matchAll(/bot\.command\("([^"]+)"/g)].map(match => match[1]).sort();
assert.deepEqual(commands, [...inventory.registered_telegram_commands].sort(), 'Telegram command census changed; investigate map coverage');
const keys = [...readFileSync(join(repo, 'packages/kernel/src/reference/metrics/registry.ts'), 'utf8').matchAll(/^  "?([\w.]+)"?: \{ compute:/gm)].map(match => match[1]).sort();
assert.deepEqual(keys, inventory.diagnostic_metrics.map(metric => metric.key).sort(), 'Diagnostic metric census changed; investigate map coverage');
const toolSource = ['packages/engine/src/sport/memory-tools.ts', 'packages/engine/src/sport/platform-tools.ts', 'packages/sport-cycling/src/tools.ts'].map(path => readFileSync(join(repo, path), 'utf8')).join('\n');
for (const name of inventory.ordinary_baseline_tools) assert.ok(new RegExp(`\\b${name}\\s*:`).test(toolSource), `Tool disappeared: ${name}`);
const approval = ['review-and-approval', 'restrictions', 'changed-workouts', 'recovery'].map(slug => readFileSync(join(skill, 'references/features', slug + '.md'), 'utf8')).join('\n');
const covered = new Set(approval.match(/\b[ABCD]\d{2}\b/g));
for (const match of approval.matchAll(/\b([ABCD])(\d{2})[–-]([ABCD])(\d{2})\b/g)) {
  assert.equal(match[1], match[3], 'Acceptance ranges must stay within one group');
  for (let number = Number(match[2]); number <= Number(match[4]); number += 1) covered.add(match[1] + String(number).padStart(2, '0'));
}
assert.deepEqual([...covered].sort(), [...inventory.approval_acceptance_ids].sort(), 'Approval acceptance mapping changed');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
console.log(JSON.stringify({ status: 'PASS', check: 'feature-map-consistency', featurePages: map.features.length, mappedInventoryEntries: actual.length, sourceAndTestPaths: pathsChecked, telegramCommands: commands.length, diagnosticMetricKeys: keys.length, approvalCriteria: covered.size, sourceRevision: revision, inspectedRevision: map.source_revision, sourceReviewRequired: revision !== map.source_revision, runtimeCoverage: 'not_established_by_this_check' }, null, 2));

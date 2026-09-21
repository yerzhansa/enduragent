import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';
import { coachingCases, coachingSequences, athleteFixture } from './coaching-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.argv.find(value => value.startsWith('--repo='))?.slice(7) ?? process.cwd());
const scenario = process.argv.find(value => value.startsWith('--scenario='))?.slice(11) ?? 'memory';
assert.ok(Object.hasOwn(coachingSequences, scenario), 'Choose memory, data, or planning');
const binary = doctor(repo);
process.umask(0o077);
const evidenceRoot = join(tmpdir(), 'enduragent-verify-npm');
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(evidenceRoot, `coaching-${scenario}-`));
const root = mkdtempSync(join(tmpdir(), 'enduragent-coaching-fictional-'));
const calendar = join(root, 'calendar.json');
const tracePath = join(root, 'coaching-trace.json');
const children = [];
let transcript = '';
let failure;
let interrupted = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const onSignal = () => { interrupted = true; for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

function launch() {
  assert.equal(interrupted, false, 'Verification interrupted');
  const child = spawn(process.execPath, ['--import', join(here, 'coaching-fixture.mjs'), binary], {
    cwd: repo,
    env: { PATH: process.env.PATH, WORKOUT_VERIFY_REPO: repo, CYCLING_COACH_HOME: root, CYCLING_COACH_NO_UPDATE_CHECK: '1', LLM_PROVIDER: 'deepseek', LLM_MODEL: 'deepseek-v4-flash', DEEPSEEK_API_KEY: 'fictional-key', LLM_API_KEY: 'fictional-key', INTERVALS_API_KEY: 'fictional-key', INTERVALS_ATHLETE_ID: '0', CYCLING_COACH_LLM_PROVIDER: 'deepseek', CYCLING_COACH_LLM_MODEL: 'deepseek-v4-flash', CYCLING_COACH_DEEPSEEK_API_KEY: 'fictional-key', CYCLING_COACH_INTERVALS_API_KEY: 'fictional-key', CYCLING_COACH_INTERVALS_ATHLETE_ID: '0', CYCLING_COACH_TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN: '', COACH_TZ: 'UTC', ENDURAGENT_LANGUAGE: 'en', WORKOUT_FIXTURE_CALENDAR: calendar, WORKOUT_FIXTURE_SCENARIO: 'mixed' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  const append = chunk => { output += chunk; transcript += chunk; };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => { failure ??= error; });
  return { process: child, read: () => output };
}

function send(handle, message) {
  transcript += `\nUSER: ${message}\n`;
  handle.process.stdin.write(message + '\n');
}

async function until(handle, text, offset = 0) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (handle.read().slice(offset).includes(text)) return;
    if (handle.process.exitCode !== null || handle.process.signalCode !== null) throw new Error(`npm exited before ${text}`);
    await delay(50);
  }
  throw new Error(`npm did not display ${text}`);
}

function files(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function savedPlan() { return files().find(path => path.endsWith('/plans/current-plan.json')); }
function observed(id) { return JSON.parse(readFileSync(tracePath, 'utf8')).turns.findLast(turn => turn.caseId === id); }
function value(id, tool) {
  const result = observed(id)?.observations.find(item => item.name === tool)?.result;
  assert.notEqual(result, undefined, `Missing production result ${id}/${tool}`);
  const data = result?.data ?? result;
  assert.ok(!data?.error, `Production tool failed ${tool}: ${JSON.stringify(data)}`);
  assert.ok(typeof data !== 'string' || !data.startsWith('Error:'), `Production tool failed ${tool}: ${data}`);
  return data;
}

async function turn(handle, id) {
  const offset = handle.read().length;
  send(handle, coachingCases[id].request);
  await until(handle, `Fixture turn complete ${id}.`, offset);
  if (id !== 'save') await until(handle, '> ', offset);
  for (const call of coachingCases[id].calls) value(id, call.name);
  assert.equal(JSON.parse(readFileSync(calendar, 'utf8')).writes.length, 0, 'Coaching must not mutate the calendar');
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', done); reject(new Error('Owned npm process did not exit')); }, 5000);
    function done() { clearTimeout(timer); resolve(); }
    child.once('exit', done);
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await waitForExit(child); } catch { child.kill('SIGKILL'); await waitForExit(child); }
}

try {
  let handle = launch();
  await until(handle, '> ');
  for (const id of coachingSequences[scenario]) {
    await turn(handle, id);
    if (id === 'draft') assert.equal(savedPlan(), undefined, 'Draft generation must not save a plan');
    if (id === 'save') {
      await until(handle, 'y/N');
      assert.equal(savedPlan(), undefined, 'Plan save must wait for explicit confirmation');
      assert.equal(value('save', 'plan_save').pendingConfirmation, true);
      let offset = handle.read().length;
      send(handle, 'n');
      await until(handle, '> ', offset);
      assert.equal(savedPlan(), undefined, 'Declining must not save the plan');
      await turn(handle, 'save');
      offset = handle.read().length;
      send(handle, 'y');
      await until(handle, '> ', offset);
      assert.ok(savedPlan(), 'Approved plan must be persisted');
      const stored = JSON.parse(readFileSync(savedPlan(), 'utf8'));
      assert.equal(stored.name, 'Fictional fitness plan');
      const draft = value('draft', 'build_plan_skeleton');
      for (const key of Object.keys(draft).filter(key => key !== 'name')) assert.deepEqual(stored[key], draft[key], `Saving must preserve draft ${key}`);
    }
  }
  if (scenario === 'memory') {
    const memoryFile = files().find(path => path.endsWith('/memory/MEMORY.md'));
    assert.ok(memoryFile, 'Memory section file must exist');
    const memory = readFileSync(memoryFile, 'utf8');
    assert.match(memory, /I prefer evening training\./);
    assert.doesNotMatch(memory, /I prefer morning training\./);
    const ledger = files().find(path => path.endsWith('/memory/events.jsonl'));
    assert.ok(ledger);
    assert.match(readFileSync(ledger, 'utf8'), /Train in the evening because of my schedule/);
    const journal = files().find(path => path.endsWith('/memory/MEMORY.history.jsonl'));
    assert.ok(journal);
    const history = readFileSync(journal, 'utf8');
    assert.match(history, /morning training/);
    assert.match(history, /evening training/);
    const recall = JSON.stringify(value('recall', 'memory_query'));
    assert.match(recall, /easy ride felt comfortable/);
    assert.match(recall, /Train in the evening/);
    assert.match(recall, /morning training/);
  }
  if (scenario === 'data') {
    const profile = value('profile', 'intervals_fetch_athlete');
    assert.equal(profile.sportSettings[0].ftp, 280);
    const wellness = value('profile', 'intervals_fetch_wellness');
    assert.equal(wellness.at(-1).hrv, 64);
    const list = value('brief', 'intervals_fetch_activities');
    assert.ok(JSON.stringify(list).includes('Fictional endurance ride'));
    assert.ok(!observed('brief').observations.some(item => item.name === 'intervals_fetch_streams'));
    const detail = value('deep', 'intervals_fetch_activity');
    assert.equal(detail.laps.length, 2);
    const streams = value('deep', 'intervals_fetch_streams');
    assert.equal(streams.sampleCount, 4);
    assert.deepEqual(streams.channels.watts, { min: 100, max: 300, mean: 200 });
    assert.deepEqual(streams.channels.heartrate, { min: 120, max: 150, mean: 135 });
    assert.ok(!Array.isArray(streams.channels.watts));
    assert.match(observed('profile').context, /280/);
    assert.deepEqual(value('numbers', 'intervals_fetch_activity'), detail);
  }
  if (scenario === 'planning') {
    const zones = value('zones', 'calculate_zones');
    assert.equal(zones.length, 6);
    assert.deepEqual(zones.map(zone => zone.value), ['< 154W', '157-210W', '213-252W', '246-263W', '255-294W', '297-336W']);
    assert.equal(value('feasibility', 'assess_feasibility').message, 'Goal appears achievable within one plan cycle.');
    assert.deepEqual(value('week', 'get_sample_week').map(session => session.day), ['Tue', 'Thu', 'Sat']);
    const draft = value('draft', 'build_plan_skeleton');
    assert.equal(draft.totalWeeks, 12);
    assert.equal(draft.phases.reduce((weeks, phase) => weeks + phase.durationWeeks, 0), 12);
    assert.ok(Array.isArray(draft.phases) && draft.phases.length > 0);
    assert.equal(value('load', 'plan_load').name, 'Fictional fitness plan');
  }
  if (scenario !== 'data') {
    send(handle, '/quit');
    await waitForExit(handle.process);
    assert.equal(handle.process.exitCode, 0);
    transcript += '\nFICTIONAL PROCESS RESTART\n';
    handle = launch();
    await until(handle, '> ');
    await turn(handle, scenario === 'memory' ? 'recall' : 'load');
    if (scenario === 'memory') {
      assert.match(observed('recall').context, /I prefer evening training/);
      assert.match(JSON.stringify(value('recall', 'memory_query')), /Train in the evening/);
    } else assert.deepEqual(value('load', 'plan_load'), JSON.parse(readFileSync(savedPlan(), 'utf8')));
  }
  send(handle, '/quit');
  await waitForExit(handle.process);
  assert.equal(handle.process.exitCode, 0);
} catch (error) {
  failure = error;
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  const sanitize = text => text.replaceAll(root, '<isolated-data-directory>').replaceAll(repo, '<checkout>').replaceAll(here, '<verification-scripts>');
  writeFileSync(join(evidence, 'transcript.txt'), sanitize(transcript));
  writeFileSync(join(evidence, 'athlete-fixture.json'), JSON.stringify(athleteFixture, null, 2));
  for (const name of ['calendar.json', 'coaching-trace.json']) if (existsSync(join(root, name))) writeFileSync(join(evidence, name), sanitize(readFileSync(join(root, name), 'utf8')));
  for (const path of files().filter(path => /\/(memory|plans)\//.test(path))) {
    const destination = join(evidence, 'persisted', relative(root, path));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, sanitize(readFileSync(path, 'utf8')));
  }
  rmSync(root, { recursive: true, force: true });
  const livePids = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid);
  const result = { scenario, status: failure ? 'FAIL' : 'PASS', executor: 'built-npm-terminal-coaching', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), runtime: process.version, platform: process.platform, boundaries: 'Scripted model selects production tools and displays actual tool results; fictional athlete/calendar; no real model judgment or Telegram proof', cleanup: { livePids, scratchRemoved: !existsSync(root), listenersOpened: 0 }, ...(failure ? { error: sanitize(failure.message) } : {}) };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(livePids.length, 0);
  assert.equal(existsSync(root), false);
  console.log(`Evidence: ${evidence}`);
  console.log(`${scenario}: ${result.status}`);
  if (failure) console.error(sanitize(failure.message));
}

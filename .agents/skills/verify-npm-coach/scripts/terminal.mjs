import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(process.argv.find(arg => arg.startsWith('--repo='))?.slice(7) ?? process.cwd());
const binary = doctor(worktree);
process.umask(0o077);
const restart = process.argv.includes('--restart');
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1] ?? 'mixed';
assert.ok(['single','mixed','revision','cancel','long','stale','retry','incomplete'].includes(scenario), 'Unknown scenario');
const evidenceRoot = join(tmpdir(), 'enduragent-verify-npm');
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(evidenceRoot, 'terminal-'));
const root = mkdtempSync(join(tmpdir(),'enduragent-npm-fictional-'));
const calendar = join(root,'calendar.json');
const children = [];
let interrupted = false;
const onSignal = () => { interrupted = true; for (const owned of children) if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM'); };
process.on('SIGINT',onSignal);
process.on('SIGTERM',onSignal);
let failure;
let child;
function assertReadableWorkoutReview(text) {
 const start = text.indexOf('Review all workout changes');
 assert.notEqual(start,-1,'A complete workout review must be displayed');
 const review = text.slice(start);
 assert.match(review,/Workout steps:/);
 assert.match(review,/5 min · 45 → 65% FTP/);
 assert.match(review,/3 ×/);
 assert.match(review,/10 min · 75% FTP · 85–95 rpm/);
 assert.match(review,/2 ×/);
 assert.doesNotMatch(review,/Workout steps unavailable|"steps"|"reps"|"ramp"|"power"|"units"|\{"/);
}
let transcript = '';
const delay = (ms) => new Promise(resolve => setTimeout(resolve,ms));
function launch() {
 assert.equal(interrupted,false,'Verification interrupted');
 const launched = spawn(process.execPath,['--import',join(here,'npm-fixture.mjs'),join(worktree,'packages/cycling-coach/dist/index.js')],{
  cwd:worktree,
  env:{PATH:process.env.PATH,WORKOUT_VERIFY_REPO:worktree,CYCLING_COACH_HOME:root,CYCLING_COACH_NO_UPDATE_CHECK:'1',LLM_PROVIDER:'deepseek',LLM_MODEL:'deepseek-v4-flash',DEEPSEEK_API_KEY:'fictional-key',LLM_API_KEY:'fictional-key',INTERVALS_API_KEY:'fictional-key',INTERVALS_ATHLETE_ID:'0',CYCLING_COACH_LLM_PROVIDER:'deepseek',CYCLING_COACH_LLM_MODEL:'deepseek-v4-flash',CYCLING_COACH_DEEPSEEK_API_KEY:'fictional-key',CYCLING_COACH_INTERVALS_API_KEY:'fictional-key',CYCLING_COACH_INTERVALS_ATHLETE_ID:'0',CYCLING_COACH_TELEGRAM_BOT_TOKEN:'',TELEGRAM_BOT_TOKEN:'',COACH_TZ:'UTC',ENDURAGENT_LANGUAGE:'en',WORKOUT_FIXTURE_CALENDAR:calendar,WORKOUT_FIXTURE_SCENARIO:scenario},
  stdio:['pipe','pipe','pipe'],
 });
 children.push(launched);
 let output='';
 launched.stdout.on('data',chunk=>{output+=chunk;transcript+=chunk;});
 launched.stderr.on('data',chunk=>{output+=chunk;transcript+=chunk;});
 return {process:launched,read:()=>output};
}
function send(handle,message) {
 transcript += `\nUSER: ${message}\n`;
 handle.process.stdin.write(message+'\n');
}
async function until(handle,text,offset=0) {
 for(let attempt=0;attempt<600;attempt++) {
  if(handle.read().slice(offset).includes(text)) return;
  if(handle.process.exitCode!==null || handle.process.signalCode!==null) throw new Error(`npm exited ${handle.process.exitCode} before ${text}\n${handle.read()}`);
  await delay(50);
 }
 throw new Error(`npm did not display ${text}\n${handle.read()}`);
}
try {
 child=launch();
 await until(child,'> ');
 const request = scenario === 'single' ? 'Prepare one easy ride.' : scenario === 'long' ? 'Prepare all 85 strength sessions.' : 'Prepare my mixed set of four workout changes.';
 send(child,request);
 if (scenario === 'incomplete') {
  await until(child,'The complete proposal could not be prepared.');
  assert.doesNotMatch(child.read(),/Type approve/);
  const offset=child.read().length;
  send(child,'How did I sleep?');
  await until(child,'Your sleep question is unrelated',offset);
  await until(child,'> ',offset);
  assert.doesNotMatch(child.read().slice(offset),/The complete proposal could not be prepared/);
  assert.equal(JSON.parse(readFileSync(calendar)).writes.length,0);
 } else {
 await until(child,'Type approve');
 assert.equal(JSON.parse(readFileSync(calendar)).writes.length,0,'review must not write');
 if (!['single','long'].includes(scenario)) {
  assert.match(child.read(),/155 min/);
  assertReadableWorkoutReview(child.read());
 }
 assert.match(child.read(),/Existing ride/);
 if(restart) {
  await stop(child.process);
  transcript+='\n--- FICTIONAL PROCESS RESTART ---\n';
  child=launch();
  await until(child,'Type approve');
  assert.equal(JSON.parse(readFileSync(calendar)).writes.length,0);
 }
 if (scenario === 'revision') {
  const offset=child.read().length;
  send(child,'Make Thursday easier');
  await until(child,'Type approve',offset);
  assert.match(child.read().slice(offset),/45 min/);
  assert.match(child.read().slice(offset),/Proposed: 1998-09-09 · Planned tempo · 45 min/);
  assert.match(child.read().slice(offset),/Estimated training load: 35/);
  assertReadableWorkoutReview(child.read().slice(offset));
 }
 if (scenario === 'stale') {
  const altered=JSON.parse(readFileSync(calendar));
  transcript += '\nFIXTURE: target 101 duration changed from 60 to 90 minutes before approval.\n';
  altered.events.find(event=>event.id===101).moving_time=5400;
  writeFileSync(calendar,JSON.stringify(altered));
 }
 let offset=child.read().length;
 send(child,scenario==='cancel'?'cancel':'approve');
 if (scenario === 'stale') {
  await until(child,'Type approve',offset);
  assert.match(child.read().slice(offset),/changed in intervals\.icu: duration: 60 min → 90 min\./);
  assert.match(child.read().slice(offset),/No changes were applied\./);
  assertReadableWorkoutReview(child.read().slice(offset));
  assert.equal(JSON.parse(readFileSync(calendar)).writes.length,0);
  offset=child.read().length;
  send(child,'approve');
 }
 if (scenario === 'retry') {
  await until(child,'Type retry',offset);
  assert.equal(JSON.parse(readFileSync(calendar)).writes.length,2);
  offset=child.read().length;
  send(child,'retry');
 }
 await until(child,scenario==='cancel'?'The remaining changes were canceled.':'All reviewed changes are complete.',offset);
 }
 const state=JSON.parse(readFileSync(calendar));
 assert.equal(state.writes.length,['cancel','incomplete'].includes(scenario)?0:scenario==='single'?1:scenario==='long'?85:4);
 if (!['single','long','cancel','incomplete'].includes(scenario)) {
  assert.deepEqual(state.writes.map(x=>x.method),['POST','POST','PUT','DELETE']);
  assert.equal(state.events.find(x=>x.id===101).moving_time,scenario==='revision'?2700:4500);
  if (scenario === 'revision') {
   assert.equal(state.events.find(x=>x.id===101).name,'Planned tempo');
   assert.equal(state.events.find(x=>x.id===101).icu_training_load,35);
  }
  assert.equal(state.events.some(x=>x.id===102),false);
 }
 assert.equal(state.events.find(x=>x.id===103).moving_time,2700);
 const label=restart?'terminal-restart':`terminal-${scenario}`;
 send(child,'/quit');
 await waitForExit(child.process);
 console.log(`${label}: built npm process, reviewed effects and retained workout PASS`);
} catch (error) {
 failure = error;
 process.exitCode = 1;
} finally {
 for (const owned of children) await stop(owned);
 process.off('SIGINT',onSignal);
 process.off('SIGTERM',onSignal);
 const sanitize = value => value.replaceAll(root,'<isolated-data-directory>').replaceAll(worktree,'<checkout>').replaceAll(here,'<verification-scripts>');
 writeFileSync(join(evidence,'transcript.txt'),sanitize(transcript));
 if (existsSync(calendar)) writeFileSync(join(evidence,'calendar.json'),readFileSync(calendar));
 rmSync(root,{recursive:true,force:true});
 const livePids = children.filter(owned => owned.exitCode === null && owned.signalCode === null).map(owned => owned.pid);
 const result = { scenario, restart, status: failure ? 'FAIL' : 'PASS', revision: execFileSync('git',['rev-parse','HEAD'],{cwd:worktree,encoding:'utf8'}).trim(), binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), runtime:process.version, platform:process.platform, executor:'built-npm-terminal', boundaries:'fictional provider and calendar; all other fetch destinations refused', cleanup:{livePids,scratchRemoved:!existsSync(root),listenersOpened:0}, ...(failure ? {error:sanitize(failure.message)} : {}) };
 writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2));
 assert.equal(livePids.length,0,'Owned process remains');
 assert.equal(existsSync(root),false,'Owned scratch remains');
 console.log(`Evidence: ${evidence}`);
 if (failure) console.error(sanitize(failure.message));
}

async function waitForExit(owned) {
 if (owned.exitCode !== null || owned.signalCode !== null) return;
 await new Promise((resolve,reject) => {
  const timer = setTimeout(() => {owned.off('exit',done);reject(new Error('Owned npm process did not exit'));},5000);
  function done() {clearTimeout(timer);resolve();}
  owned.once('exit',done);
 });
}
async function stop(owned) {
 if (owned.exitCode !== null || owned.signalCode !== null) return;
 owned.kill('SIGTERM');
 try { await waitForExit(owned); } catch { owned.kill('SIGKILL'); await waitForExit(owned); }
}


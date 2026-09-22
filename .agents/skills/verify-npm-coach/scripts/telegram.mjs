import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';

const repo = resolve(process.argv.find(x => x.startsWith('--repo='))?.slice(7) ?? process.cwd());
const binary = doctor(repo);
const scenario = process.argv.find(x => x.startsWith('--scenario='))?.slice(11) ?? 'mixed';
assert.ok(['single','mixed','revision','cancel','long','stale','retry','incomplete','delivery'].includes(scenario),'Unknown scenario');
assert.equal(process.platform,'darwin','This live Telegram recipe requires macOS');
const configPath = process.env.NPM_VERIFY_TELEGRAM_CONFIG;
assert.ok(configPath,'BLOCKED: set NPM_VERIFY_TELEGRAM_CONFIG to a private dedicated-test-bot JSON file');
const metadata = statSync(configPath);
assert.equal(metadata.mode & 0o077,0,'Telegram test credentials must have mode 600');
assert.equal(metadata.uid,process.getuid(),'Telegram test credentials must belong to this user');
const config = JSON.parse(readFileSync(configPath,'utf8'));
const authorizedExisting = process.argv.includes('--authorized-existing-dev-bot');
if (authorizedExisting) {
 assert.equal(config.operatorAuthorized,true,'Explicit operator authorization is required');
 assert.equal(config.botUsername,'cycling_coach_111_bot','Only the named development bot is authorized');
} else assert.equal(config.disposable,true,'Require a dedicated disposable bot and Telegram test account');
assert.match(config.operatorId,/^[1-9]\d+$/);
assert.match(config.botToken,/^\d+:[A-Za-z0-9_-]+$/);
assert.match(config.botUsername,/^[A-Za-z0-9_]+bot$/i);
assert.ok(authorizedExisting || !['cycling_coach_111_bot','local_prod_cycling_coach_bot'].includes(config.botUsername.toLowerCase()),'Shared bots require explicit operator authorization');
async function api(method) {
 try {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`,{signal:AbortSignal.timeout(15000)});
  const data = await response.json();
  assert.equal(data.ok,true);
  return data.result;
 } catch { throw new Error(`BLOCKED: Telegram ${method} preflight failed; credentials withheld`); }
}
const identity = await api('getMe');
assert.equal(identity.username.toLowerCase(),config.botUsername.toLowerCase(),'Dedicated bot identity mismatch');
const webhook = await api('getWebhookInfo');
assert.equal(webhook.url,'','Dedicated bot has an active webhook');
assert.equal(webhook.pending_update_count,0,'Dedicated bot has pending messages; resolve them before this run');
console.log('DOCTOR: dedicated Telegram identity and empty webhook queue verified');
if (process.argv.includes('--doctor-only')) process.exit(0);
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(),'enduragent-npm-telegram-'));
const evidenceRoot = join(tmpdir(),'enduragent-verify-npm');
mkdirSync(evidenceRoot,{recursive:true,mode:0o700});
const evidence = mkdtempSync(join(evidenceRoot,'telegram-'));
const calendar = join(root,'calendar.json');
const telegramLog = join(evidence,'telegram-api.jsonl');
const fixture = join(dirname(fileURLToPath(import.meta.url)),'npm-fixture.mjs');
let transcript = '';
let ready = false;
const child = spawn(process.execPath,['--import',fixture,binary],{
 cwd:repo,
 env:{PATH:process.env.PATH,WORKOUT_VERIFY_REPO:repo,CYCLING_COACH_HOME:root,CYCLING_COACH_NO_UPDATE_CHECK:'1',LLM_PROVIDER:'deepseek',LLM_MODEL:'deepseek-v4-flash',DEEPSEEK_API_KEY:'fictional-key',LLM_API_KEY:'fictional-key',INTERVALS_API_KEY:'fictional-key',INTERVALS_ATHLETE_ID:'0',TELEGRAM_BOT_TOKEN:config.botToken,CYCLING_COACH_OPERATOR_ID:config.operatorId,COACH_TZ:'UTC',ENDURAGENT_LANGUAGE:'en',WORKOUT_FIXTURE_CALENDAR:calendar,WORKOUT_FIXTURE_SCENARIO:scenario,WORKOUT_FIXTURE_TELEGRAM_LOG:telegramLog},
 stdio:['ignore','pipe','pipe'],
});
let failure;
const onOutput = chunk => {
 transcript += chunk;
 if (!ready && transcript.includes('(Telegram mode) is running')) {
  ready = true;
  console.log(`READY: @${config.botUsername}; scenario=${scenario}; fictional date=1998-09-07`);
  console.log(`Calendar read-only view: ${calendar}`);
  console.log(`Evidence: ${evidence}`);
 }
};
child.stdout.on('data',onOutput);
child.stderr.on('data',onOutput);
const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
const startup = setTimeout(() => { if(!ready) {failure='Telegram startup timed out';stop();requestStop();} },45000);
let forced;
const requestStop = () => { forced ??= setTimeout(() => child.kill('SIGKILL'),5000); };
process.on('SIGINT',requestStop);
process.on('SIGTERM',requestStop);
try {
 if (scenario === 'delivery') {
  let sawHint = false;
  let armedAt;
  for (let attempt = 0; attempt < 450 && child.exitCode === null && child.signalCode === null; attempt++) {
   if (ready && armedAt === undefined) armedAt = Date.now();
   const logged = existsSync(telegramLog) ? readFileSync(telegramLog,'utf8') : '';
   if (logged.includes('had trouble delivering')) {
    sawHint = true;
    break;
   }
   if (armedAt !== undefined && Date.now() - armedAt > 12000 && !logged.includes('"update":true')) {
    throw new Error('Telegram transport was not intercepted');
   }
   if (armedAt !== undefined && Date.now() - armedAt > 20000) break;
   await new Promise(resolve => setTimeout(resolve, 200));
  }
  stop();
  requestStop();
  const lines = existsSync(telegramLog)
   ? readFileSync(telegramLog,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
   : [];
  const sends = lines.filter(line => line.method === 'sendMessage');
  assert.equal(sawHint, true, `delivery hint was not sent\n${existsSync(telegramLog) ? readFileSync(telegramLog,'utf8') : ''}`);
  assert.equal(sends.some(line => line.ok === false), true, 'generated answer must fail to send');
  assert.equal(sends.some(line => line.ok === true && String(line.text).includes('I generated the answer, but Telegram had trouble delivering it.')), true, 'delivery hint missing');
  assert.equal(sends.some(line => line.ok === true && line.reply_markup != null), false, 'approval must not be delivered');
 }
 await new Promise((resolve,reject) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
  else {
   child.once('exit',resolve);
   child.once('error',reject);
  }
 });
} catch (error) {
 failure = error instanceof Error ? error.message : 'Owned npm child failed to start';
 stop();
}
finally {
 if (child.exitCode === null && child.signalCode === null) {
  stop();
  await new Promise(resolve => {
   const timer = setTimeout(resolve, 6000);
   child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
 }
 clearTimeout(startup);
 clearTimeout(forced);
 process.off('SIGINT',stop);
 process.off('SIGTERM',stop);
 process.off('SIGINT',requestStop);
 process.off('SIGTERM',requestStop);
 const sanitize = value => value.replaceAll(config.botToken,'<bot-token>').replaceAll(config.operatorId,'<test-operator>').replaceAll(root,'<isolated-data-directory>').replaceAll(repo,'<checkout>').replaceAll(dirname(fileURLToPath(import.meta.url)),'<verification-scripts>').replace(/\bi\d{8,9}\b/g,'<athlete>').replace(/\b\d{6,}\b/g,'<identifier>');
 writeFileSync(join(evidence,'runtime.txt'),sanitize(transcript));
 if (existsSync(calendar)) writeFileSync(join(evidence,'calendar.json'),readFileSync(calendar));
 rmSync(root,{recursive:true,force:true});
 const livePids = child.exitCode === null && child.signalCode === null && child.pid ? [child.pid] : [];
 if (existsSync(telegramLog)) writeFileSync(telegramLog, sanitize(readFileSync(telegramLog,'utf8')));
 const status = !ready ? 'BLOCKED' : failure ? 'FAIL' : scenario === 'delivery' ? 'PASS' : 'NOT RUN';
 const reason = failure ?? (scenario === 'delivery' ? 'Fictional Telegram send failed after a generated answer' : 'Record browser action and result separately; startup is not feature proof');
 writeFileSync(join(evidence,'result.json'),JSON.stringify({scenario,channel:'Telegram',status,reason,revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),cleanup:{livePids,scratchRemoved:!existsSync(root),listenersOpened:0}},null,2));
 assert.equal(livePids.length,0,'Owned child remains');
 assert.equal(existsSync(root),false,'Owned scratch remains');
 console.log(`CLEANUP: owned child stopped and scratch removed; evidence retained at ${evidence}`);
 if(failure||!ready)process.exitCode=1;
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
const require = createRequire(join(process.env.WORKOUT_VERIFY_REPO, 'package.json'));
const FakeTimers = require('@sinonjs/fake-timers');
FakeTimers.install({ now: Date.parse('1998-09-07T12:00:00Z'), toFake: ['Date'], shouldAdvanceTime: true });
const calendarPath = process.env.WORKOUT_FIXTURE_CALENDAR;
if (!calendarPath) throw new Error('Fictional calendar file is required.');
const tempoWorkout = {
  duration: 3600,
  steps: [
    { duration: 300, warmup: true, ramp: true, power: { start: 45, end: 65, units: '%ftp' }, heartrate: { value: 130, units: 'bpm' } },
    { reps: 3, text: '3x', duration: 2700, steps: [
      { duration: 600, power: { value: 75, units: '%ftp' }, cadence: { start: 85, end: 95, units: 'rpm' } },
      { duration: 300, power: { value: 50, units: '%ftp' } },
    ] },
    { duration: 600, cooldown: true, ramp: true, power: { start: 60, end: 45, units: '%ftp' } },
  ],
};
const recoveryWorkout = {
  duration: 1800,
  steps: [
    { duration: 300, warmup: true, ramp: true, power: { start: 40, end: 55, units: '%ftp' } },
    { reps: 2, text: '2x', duration: 1200, steps: [
      { duration: 300, power: { value: 55, units: '%ftp' } },
      { duration: 300, power: { value: 45, units: '%ftp' } },
    ] },
    { duration: 300, cooldown: true, power: { value: 45, units: '%ftp' } },
  ],
};
const initial = [
  { id: 101, start_date_local: '1998-09-09T00:00:00', name: 'Tempo ride', category: 'WORKOUT', type: 'Ride', moving_time: 3600, description: 'Comfortable tempo', workout_doc: tempoWorkout, tags: ['cycling-coach'] },
  { id: 102, start_date_local: '1998-09-10T00:00:00', name: 'Recovery ride', category: 'WORKOUT', type: 'Ride', moving_time: 1800, description: 'Easy recovery', workout_doc: recoveryWorkout, tags: ['cycling-coach'] },
  { id: 103, start_date_local: '1998-09-08T00:00:00', name: 'Existing ride', category: 'WORKOUT', type: 'Ride', moving_time: 2700, description: 'Keep this ride', tags: [] },
];
const state = existsSync(calendarPath) ? JSON.parse(readFileSync(calendarPath, 'utf8')) : { events: initial, writes: [] };
const save = () => writeFileSync(calendarPath, JSON.stringify(state, null, 2));
save();
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});
const proposal = { preparation: { kind:'complete', changes: [
  {kind:'add-cycling', date:'1998-09-08', workout:{name:'Easy ride', steps:[{type:'steady',duration:{value:50,unit:'minutes'},power:{kind:'percent_ftp',value:60}}]}},
  {kind:'add-strength',date:'1998-09-08',name:'Strength',durationMinutes:30,effort:'Easy strength',description:'Controlled movements'},
  {kind:'edit',eventId:101,patch:{durationSeconds:4500,name:'Planned tempo',trainingLoad:35}},
  {kind:'delete',eventId:102},
] }};
const scenario = process.env.WORKOUT_FIXTURE_SCENARIO ?? 'mixed';
if (scenario === 'single') proposal.preparation.changes = proposal.preparation.changes.slice(0, 1);
if (scenario === 'long') proposal.preparation.changes = Array.from({length:85}, (_, index) => ({kind:'add-strength',date:'1998-09-08',name:`Strength ${index + 1}`,durationMinutes:30,effort:'Easy strength',description:'Controlled movements'}));
if (scenario === 'incomplete') proposal.preparation = {kind:'incomplete',reason:'Fictional preparation stopped before completing the requested set.'};
let modelCalls = 0;
const telegramLog = process.env.WORKOUT_FIXTURE_TELEGRAM_LOG;
let deliveryUpdateSent = false;
let deliveryAnswerRejected = false;
const recordTelegram = (entry) => {
 if (!telegramLog) return;
 writeFileSync(telegramLog, `${JSON.stringify(entry)}\n`, {flag:'a'});
};
async function telegramResult(methodName, body) {
 if (methodName === 'getUpdates') {
  if (deliveryUpdateSent) {
   await new Promise(resolve => setTimeout(resolve, 250));
   return {ok:true,result:[]};
  }
  deliveryUpdateSent = true;
  recordTelegram({method:methodName,ok:true,update:true});
 } else if (methodName !== 'sendMessage') recordTelegram({method:methodName,ok:true});
 if (methodName === 'getWebhookInfo') return {ok:true,result:{url:'',has_custom_certificate:false,pending_update_count:0}};
 if (methodName === 'getUpdates') {
  const operatorId = Number(process.env.CYCLING_COACH_OPERATOR_ID);
  return {ok:true,result:[{update_id:1,message:{message_id:1,date:905169600,chat:{id:operatorId,type:'private'},from:{id:operatorId,is_bot:false,first_name:'Fixture'},text:'How is my form?'}}]};
 }
 if (methodName === 'sendMessage') {
  const text = typeof body?.text === 'string' ? body.text : '';
  const hint = text.includes('had trouble delivering');
  const welcome = text.startsWith('Welcome');
  const fail = !deliveryAnswerRejected && !hint && !welcome;
  if (fail) deliveryAnswerRejected = true;
  recordTelegram({method:methodName,text,ok:!fail,reply_markup:body?.reply_markup ?? null});
  if (fail) return {ok:false,error_code:500,description:'fictional delivery failure'};
  return {ok:true,result:{message_id:2,date:905169600,chat:{id:body?.chat_id,type:'private'},text}};
 }
 if (methodName === 'getMe') return {ok:true,result:{id:1,is_bot:true,first_name:'Fixture',username:'fixture_bot'}};
 return {ok:true,result:true};
}
function installTelegramTransport() {
 for (const mod of [https, http]) {
  const original = mod.request;
  mod.request = function (input, options, callback) {
   const urlLike = typeof input === 'string' || input instanceof URL;
   const opts = urlLike ? (typeof options === 'function' ? {} : (options ?? {})) : input;
   const host = String(opts?.hostname || opts?.host || (input instanceof URL ? input.hostname : typeof input === 'string' ? input : ''));
   const path = String(opts?.path || opts?.pathname || (input instanceof URL ? `${input.pathname}${input.search}` : ''));
   if (!host.includes('api.telegram.org') && !String(input).includes('api.telegram.org')) return original.apply(this, arguments);
   const methodName = path.split('?')[0].split('/').filter(Boolean).at(-1);
   const chunks = [];
   const req = new Writable({
    write(chunk, _encoding, done) {
     chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
     done();
    },
   });
   req.on('finish', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    void telegramResult(methodName, parsed).then(payload => {
    const res = Readable.from([Buffer.from(JSON.stringify(payload))]);
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headers = {'content-type':'application/json'};
    req.emit('response', res);
    if (typeof callback === 'function') callback(res);
    else if (typeof options === 'function') options(res);
    });
   });
   req.abort = () => req.destroy();
   req.setTimeout = () => req;
   req.setHeader = () => {};
   req.getHeader = () => undefined;
   req.removeHeader = () => {};
   req.flushHeaders = () => {};
   return req;
  };
 }
}
if (scenario === 'delivery') installTelegramTransport();
globalThis.fetch = async (resource, options = {}) => {
 const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
 const method = options.method ?? (resource instanceof Request ? resource.method : 'GET');
 const rawBody = typeof options.body === 'string' ? options.body : resource instanceof Request && method !== 'GET' ? await resource.clone().text() : '';
 const body = rawBody ? JSON.parse(rawBody) : undefined;
 if (url.hostname === 'intervals.icu') {
  Object.assign(state, JSON.parse(readFileSync(calendarPath, 'utf8')));
  if (scenario === 'retry' && method === 'PUT' && !state.rejectionIssued) {state.rejectionIssued=true;save();return json({message:'Fictional calendar refusal'},400);}
  const eventMatch = /\/events\/(\d+)$/.exec(url.pathname);
  if (eventMatch) {
   const id = Number(eventMatch[1]);
   const found = state.events.find((event) => event.id === id);
   if (!found) return json({message:'Not found'},404);
   if (method === 'GET') return json(found);
   if (method === 'PUT') { Object.assign(found,body); state.writes.push({method,id,body}); save(); return json(found); }
   if (method === 'DELETE') { state.events = state.events.filter((event) => event.id !== id); state.writes.push({method,id}); save(); return json({}); }
  }
  if (url.pathname.endsWith('/events')) {
   if (method === 'POST') {const event = {...body,id:201+state.writes.length};state.events.push(event);state.writes.push({method,body});save();return json(event);}
   const oldest=url.searchParams.get('oldest')??'', newest=url.searchParams.get('newest')??'9999';
   return json(state.events.filter((event)=>event.start_date_local.slice(0,10)>=oldest&&event.start_date_local.slice(0,10)<=newest));
  }
  if (/\/athlete\/[^/]+$/.test(url.pathname)) return json({id:'0',name:'Fixture Athlete',timezone:'UTC',sport_settings:[]});
  return json([]);
 }
 if (url.hostname === 'api.deepseek.com' && scenario === 'provider-down') {
  return json({error:{message:'fictional provider outage',type:'server_error'}},500);
 }
 if (url.hostname === 'api.deepseek.com') {
  modelCalls++;
  const last = body?.messages?.at(-1);
  const lastContent = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  if (last?.role === 'user' && lastContent.includes('Classify the candidate assistant reply')) {
   const delta = {role:'assistant',content:'no_preparation_required'};
   const chunk={id:`fixture_${modelCalls}`,object:'chat.completion.chunk',created:905169600,model:'deepseek-v4-flash',choices:[{index:0,delta,finish_reason:null}]};
   const final={...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300}};
   return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }
  const unrelated = scenario === 'incomplete' && last?.role === 'user' && lastContent.includes('How did I sleep');
  const revisionRequested = scenario === 'revision' && last?.role === 'user' && JSON.stringify(last.content).includes('easier');
  const preceding = body?.messages?.at(-2);
  const pendingRead = last?.role === 'tool' && preceding?.tool_calls?.some(call => call.function?.name === 'get_pending_workout_changes');
  const finishing = (last?.role === 'tool' && !pendingRead) || unrelated;
  let toolName = 'prepare_workout_changes';
  let toolInput = proposal;
  if (revisionRequested) {
   toolName = 'get_pending_workout_changes';
   toolInput = {};
  } else if (pendingRead) {
   const result = JSON.parse(last.content);
   const pending = result.data ?? result;
   if (pending.kind !== 'pending') throw new Error('Fixture expected an authoritative pending proposal');
   const target = pending.changes.find(item => item.change.kind === 'edit' && item.change.eventId === 101);
   if (!target) throw new Error('Fixture could not locate the pending tempo edit');
   toolInput = {preparation:{kind:'revise',base:pending.reference,replacements:[{id:target.id,change:{kind:'edit',eventId:101,patch:{durationSeconds:2700}}}]}};
  }
  const delta = finishing ? {role:'assistant',content:unrelated ? 'Your sleep question is unrelated to the workout proposal.' : 'Review the workout changes below. Nothing has been changed yet.'} : {role:'assistant',content:null,tool_calls:[{index:0,id:`fixture_call_${modelCalls}`,type:'function',function:{name:toolName,arguments:JSON.stringify(toolInput)}}]};
  const chunk={id:`fixture_${modelCalls}`,object:'chat.completion.chunk',created:905169600,model:'deepseek-v4-flash',choices:[{index:0,delta,finish_reason:null}]};
  const final={...chunk,choices:[{index:0,delta:{},finish_reason:finishing?'stop':'tool_calls'}],usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300}};
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 }
 if (scenario === 'delivery' && url.hostname === 'api.telegram.org') {
  const methodName = url.pathname.split('/').filter(Boolean).at(-1);
  return json(await telegramResult(methodName, body));
 }
 return json({message:'Network disabled in isolated npm fixture'},503);
};

import './npm-fixture.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coachingCases, athleteFixture } from './coaching-cases.mjs';

const tracePath = join(process.env.CYCLING_COACH_HOME, 'coaching-trace.json');
const trace = existsSync(tracePath) ? JSON.parse(readFileSync(tracePath, 'utf8')) : { turns: [], requests: [] };
const save = () => writeFileSync(tracePath, JSON.stringify(trace, null, 2));
const fallback = globalThis.fetch;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const parse = content => { try { return JSON.parse(content); } catch { return content; } };
let sequence = 0;
save();

globalThis.fetch = async (resource, options = {}) => {
  const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
  const method = options.method ?? (resource instanceof Request ? resource.method : 'GET');
  if (url.hostname === 'intervals.icu' && method === 'GET') {
    const path = url.pathname;
    trace.requests.push({ method, path, query: url.search });
    save();
    if (/\/athlete\/[^/]+$/.test(path)) return json(athleteFixture.profile);
    if (path.endsWith('/wellness')) return json(athleteFixture.wellness);
    if (path.endsWith('/activities')) {
      const oldest = url.searchParams.get('oldest') ?? '';
      const newest = url.searchParams.get('newest') ?? '9999';
      return json(athleteFixture.activities.filter(activity => activity.start_date_local.slice(0, 10) >= oldest && activity.start_date_local.slice(0, 10) <= newest));
    }
    if (/\/activity\/301\/streams(?:\.json)?$/.test(path)) return json(athleteFixture.streams);
    if (/\/activity\/301$/.test(path)) return json({ ...athleteFixture.activities[0], laps: athleteFixture.laps });
  }
  if (url.hostname !== 'api.deepseek.com') return fallback(resource, options);
  const rawBody = typeof options.body === 'string' ? options.body : resource instanceof Request ? await resource.clone().text() : '';
  const body = JSON.parse(rawBody);
  const lastMessage = body.messages.at(-1);
  const lastText = typeof lastMessage?.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage?.content ?? '');
  if (lastMessage?.role === 'user' && lastText.includes('Classify the candidate assistant reply')) {
    const delta = { role: 'assistant', content: 'no_preparation_required' };
    const chunk = { id: `coaching_${++sequence}`, object: 'chat.completion.chunk', created: 905169600, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: null }] };
    const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user');
  const user = body.messages[lastUserIndex];
  const userText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
  const matched = Object.entries(coachingCases).find(([, value]) => userText?.includes(value.request));
  assert.ok(matched, 'No coaching case matches this request; fixture refuses to invent a successful answer');
  const [caseId, script] = matched;
  const current = body.messages.slice(lastUserIndex + 1);
  const callNames = new Map(current.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
  const observations = current.filter(message => message.role === 'tool').map(message => ({ name: callNames.get(message.tool_call_id), result: parse(message.content) }));
  const next = script.calls[observations.length];
  const context = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  let delta;
  if (next) {
    assert.ok(body.tools?.some(tool => tool.function?.name === next.name), `Production agent did not expose ${next.name}`);
    let args = next.args;
    if (args === 'draft') {
      const drafted = trace.turns.findLast(turn => turn.caseId === 'draft')?.observations.find(item => item.name === 'build_plan_skeleton')?.result;
      const data = drafted?.data ?? drafted;
      assert.ok(data && !data.error, 'Plan saving requires a successful real draft tool result');
      args = { plan: { ...data, name: 'Fictional fitness plan' } };
    }
    delta = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `coaching_call_${++sequence}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(args) } }] };
  } else {
    trace.turns.push({ caseId, request: script.request, observations, context });
    save();
    delta = { role: 'assistant', content: `Fixture observation ${caseId}: ${JSON.stringify(observations)}\nFixture turn complete ${caseId}.` };
  }
  const chunk = { id: `coaching_${++sequence}`, object: 'chat.completion.chunk', created: 905169600, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: null }] };
  const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};

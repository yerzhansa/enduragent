import type { ModelMessage } from "ai";
import type { MemorySnapshot } from "../host-ports.js";
import type { DerivedPreserveTokens, SportMemoryShape } from "../sport.js";
import {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  getMessageProvenance,
  provenanceOfMessages,
  unionProvenance,
  type SourceProvenance,
} from "../provenance.js";
import {
  estimateTokens,
  estimateMessagesTokens,
  SAFETY_MARGIN,
  MIN_PROMPT_BUDGET_TOKENS,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./token-utils.js";
import { messageText } from "../sport/model-message.js";
import { truncateUtf16Safe } from "../text-truncate.js";
import { makeSummaryMessage, SUMMARY_PREFIX } from "./history-limit.js";
import type { LLM } from "../llm.js";
import type { GenerateOptions } from "../sport.js";
import type { TurnBudget } from "./turn-budget.js";

type GenerateCallCharger = Pick<TurnBudget, "chargeGenerateCall">;

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SUMMARY_CHARS = 4_000;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Summary truncated]";
const MAX_SUMMARY_TOKENS = 1000;
const SUMMARIZATION_TIMEOUT_MS = 120_000;
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;

const REQUIRED_SUMMARY_SECTIONS = [
  "## Athlete Profile",
  "## Training Status",
  "## Coach Stance",
  "## Discussion Context",
  "## Pending Questions",
] as const;

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

function resolveTokens(
  spec: SportMemoryShape["mustPreserveTokens"],
  memory: MemorySnapshot,
): DerivedPreserveTokens {
  if (typeof spec !== "function") return { tokens: spec, provenance: EMPTY_PROVENANCE };
  try {
    const resolved = spec(memory);
    return Array.isArray(resolved)
      ? { tokens: resolved, provenance: EMPTY_PROVENANCE }
      : (resolved as DerivedPreserveTokens);
  } catch (err) {
    console.warn("Sport.mustPreserveTokens function threw; using empty list", err);
    return { tokens: [], provenance: EMPTY_PROVENANCE };
  }
}

export function resolveMustPreserveTokens(
  spec: SportMemoryShape["mustPreserveTokens"],
  memory: MemorySnapshot,
): readonly string[] {
  return resolveTokens(spec, memory).tokens;
}

function buildMustPreserveBlock(tokens: readonly string[]): string {
  const tokensClause = tokens.length > 0
    ? `\n\nPreserve these literal tokens exactly: ${tokens.join(", ")}.`
    : "";
  return `MUST PRESERVE:
- Athlete profile details (FTP, weight, experience, schedule, goals)
- Current training plan status and phase
- Recent workout feedback and performance trends
- Decisions made about training approach
- The coach's most recent stance per axis ({volume, intensity} in increase/hold/reduce/none plus rest/refer_out flags) and the receipt it was grounded in
- Any coach recommendation the athlete is currently disputing
- Any illness or symptoms mentioned
- Actions agreed but not yet executed
- Any injuries, constraints, or preferences mentioned
- The last thing the athlete asked and what was being discussed

Preserve all specific numbers exactly as written (watts, kg, percentages,
dates, distances, durations).

PRIORITIZE recent context over older history.
The coach needs to know what was being discussed, not just what topics were covered.${tokensClause}`;
}

// This block must stay at or above COMPACTION_PROMPT_MIN_CHARS: below the
// provider's minimum cacheable prefix (4096 tokens) the compaction lane
// silently stops caching, and the size is asserted by a unit test.
export const COMPACTION_PROMPT_MIN_CHARS = 18_000;

const COMPACTION_PROMPT_CORE = `You are the conversation-compaction summarizer for an endurance-coaching assistant. Older chat messages are about to be dropped from the coach's context window, and the summary you produce becomes the ONLY record of them the coach will ever see again. Anything you omit is gone for good. Anything you invent will be treated as fact by the coach in every later conversation and may end up steering a real athlete's training. Accuracy beats brevity, specifics beat generalities, and the athlete's own numbers beat everything else.

RULES, IN PRIORITY ORDER

1. Never invent a fact. If the conversation does not state something, it does not go in the summary. Do not infer a value, do not round a number to something more plausible, do not fill a gap with what is typical for athletes like this one. A missing fact is acceptable; a fabricated fact is the worst possible failure.
2. Preserve every specific number exactly as written: watts, kilograms, percentages, dates, distances, durations, paces, heart rates, temperatures, repetition counts. Write 247W, not "around 250W". Write 5:10 per km, not "just over five minutes per km". If two different values were stated for the same quantity at different times, keep BOTH with their order or dates, newest last.
3. If an existing summary of earlier context is provided in the user message, PRESERVE every fact in it unless a newer message directly supersedes it. Do not drop a fact merely because it is old, and do not re-word its numbers. When a new message supersedes an old fact, keep the new value and note the change if it matters for coaching (for example a threshold retest).
4. Aim for 300-500 words total. Use bullet points, not paragraphs. Short bullets carrying one fact each survive later compactions better than long composite sentences.
5. Always use the five exact section headings listed below, in this exact order, each on its own line, each starting with two hash marks. Never add other sections, never rename them, never leave one out - write "- None noted" under a heading rather than omitting it.
6. Prioritize recent context over older history when space is tight, but never at the cost of rule 2 or rule 3. The coach needs to know what was being discussed most recently, not just which topics came up at some point.
7. Omit generic coaching advice that could be re-derived from scratch (for example an explanation of why recovery weeks matter). Keep only what is specific to THIS athlete: their numbers, their constraints, their decisions, their disagreements, their unanswered questions.
8. Record disagreements faithfully. If the athlete pushed back on a recommendation and the coach held or changed its position, both sides of that exchange are coaching state and must be kept.
9. Write in plain, neutral prose. No emojis, no marketing language, no meta commentary about the summarization itself.

THE FIVE SECTIONS - WHAT BELONGS WHERE

## Athlete Profile
Stable facts about the person: threshold values and test results (functional threshold power in watts, critical speed or threshold pace, swim critical pace), body mass, age bracket if stated, weekly availability and schedule constraints, equipment (bike, trainer, power meter, shoes, watch), experience level, injury history and chronic conditions, dietary constraints, stated goals with their dates and target values. This section is the athlete's identity card: if the coach could plausibly need it three weeks from now, it belongs here. Do NOT put transient states here (today's fatigue, this week's plan) - those belong in Training Status.
Example bullets: "- FTP 262W (retested this month, up from 255W)", "- Right knee pain history, flares above three hard sessions per week".

## Training Status
Where the athlete is in their training right now: current phase or block, weekly volume in hours, recent key workouts and how they went, current Load / Fitness / Fatigue / Form direction if discussed, fatigue and sleep state, illness affecting this week, adjustments already made to the current week or block. This section changes fastest and should lean recent. Include concrete session outcomes with their numbers ("3x12min at 250W completed, third rep faded to 244W"), not vague impressions.
Example bullets: "- Week 2 of a 3-week build, 8.5h planned", "- Skipped Thursday intervals due to head cold, resumed easy riding Saturday".

## Coach Stance
The coach's most recent position, per axis, and the evidence it rested on: volume (increase, hold, reduce, or none), intensity (increase, hold, reduce, or none), plus any rest-day or refer-out flags. State the receipt - the specific fact the stance was grounded in ("hold intensity because resting heart rate has been elevated five mornings running"). If the athlete is currently DISPUTING a recommendation, record exactly what the coach recommended, what the athlete wants instead, and where the exchange left off. A stance without its grounding, or a dispute without both sides, is an incomplete record.
Example bullets: "- Volume: hold; intensity: reduce - grounded in elevated fatigue and poor sleep this week", "- Athlete disputes the rest day, wants to race Saturday; coach held position, athlete has not yet agreed".

## Discussion Context
What was actually being talked about, so the coach can pick the thread back up mid-sentence: the topic of the last few exchanges, any decisions made in this conversation ("agreed to move the long ride to Sunday"), any plan edits agreed but not yet executed, anything the coach promised to do or check later. This is the difference between remembering the meeting and remembering only the agenda.
Example bullets: "- Last exchange: reviewing Tuesday's interval data, athlete asked whether fading reps mean the target is too high", "- Agreed: retest FTP after the recovery week; not yet scheduled".

## Pending Questions
Questions either party asked that were never answered, and open items awaiting information: an athlete question the coach had not yet answered, a coach question the athlete had not yet answered ("how did the knee feel after the run?"), data the athlete promised to report back. If nothing is open, write "- None outstanding".
Example bullets: "- Coach asked for Saturday's sleep and morning heart rate; athlete has not replied yet".

COMMON FAILURE MODES TO AVOID

- Rounding or normalizing numbers. "FTP 262W" must not become "FTP about 260W", "roughly 4 W/kg", or "mid-two-sixties". A pace of 4:15 per km must not become "around 4:15" or "a bit over four minutes". Copy the characters.
- Dropping the units or the qualifier. "20 minutes at 276W" carries three facts: the duration, the power, and that it was a test effort. "Did a hard 20 minutes" preserves none of them.
- Averaging two stated values into one. If the athlete said 255W in March and 262W now, the summary keeps both with their order; it never says "high 250s".
- Collapsing a dispute into agreement. "Athlete and coach discussed ride length" hides that the athlete rejected a recommendation and the exchange is unresolved. The stance section must show who wants what and where it landed.
- Moving transient state into the profile. "Tired this week" is Training Status, not Athlete Profile; a summary that freezes a temporary state as identity will mislead the coach for weeks.
- Losing the receipt under a stance. "Coach recommended reducing intensity" without the grounding fact ("because resting heart rate was elevated five mornings") strips the coach of the reason it would need to re-evaluate later.
- Answering a pending question yourself. If the coach asked for sleep data and the athlete never replied, the summary records the open question; it does not guess the answer or silently drop the thread.
- Summarizing the summary. When an existing summary is provided, its facts are inputs to preserve, not text to compress further. Losing a fact from the existing summary is exactly as bad as losing one from the messages.
- Padding with coaching theory. Sentences like "consistency and recovery are the keys to improvement" carry zero athlete-specific information and waste the word budget rule 4 gives you.
- Renaming or reordering the section headings. Downstream tooling checks for the five exact headings; a summary under "## Profile" or "## Open Items" is treated as structurally invalid even if its content is perfect, and you will be asked to restructure it.

WORKED EXAMPLE 1 - CYCLING, FACTS-DENSE

Transcript:
user: Did my FTP test this morning. 20 minutes at 276W, so that puts FTP at 262W, up from 255W in March.
assistant: Great result - 262W it is, a 7W bump. I will use that for all zone work from now on. How did pacing feel?
user: First 5 minutes too hot, faded a bit at the end. Also I weighed in at 71kg today, was 73 in winter.
assistant: Noted, 71kg - that is 3.69 W/kg at the new FTP. With the fade pattern, next test start 10W lower.
user: My goal race is the Alpine Gran Fondo on 1998-08-15. 168km, 3400m of climbing. I want to finish under 7 hours.
assistant: Solid target. That course rewards steady mountain pacing around sweet spot on the long climbs, and your time to exhaustion work will matter. What is your weekly availability between now and then?
user: I can do 9 hours most weeks, 11 in a big week. Tuesdays are always off, family evening.
assistant: Understood: 9 hours typical, 11 max, never Tuesday. I will structure builds around that.
user: One more thing - left knee got grumpy last autumn when I stacked three interval days in a row. Physio said patellar tendon overload, cleared me in December.
assistant: Important history. I will cap you at two hard days back to back and watch anything you report from that knee.
user: Bike is a Canyon Ultimate with a Quarq power meter, indoor is a Kickr. Power numbers indoors read about 8W lower.
assistant: Logged - and the 8W indoor offset matters for your interval targets, thanks. For this week: two quality sessions, one long ride Sunday at 4.5 hours, rest on Tuesday as always.
user: Sounds good. Can we also plan a VO2max block before the build, like we discussed?
assistant: Yes - two weeks of VO2max work starting after the recovery week, then the sweet spot build toward the Fondo.
user: Last thing: I ride with the Thursday group, average speed is high and it always turns into a race up the second climb.
assistant: Keep the Thursday group ride, but treat it as one of your two hard days in that week - it counts against the knee rule even if it is unofficial.
user: Also, on long rides I drink one electrolyte bottle per hour when it is hot, plain water when it is cool. Should I change anything?
assistant: Keep that - one bottle per hour above 25C is a sound habit for a 7-hour goal ride. Log it so we can check it against how the final climbs feel.
user: And what will the VO2max block sessions actually look like?
assistant: Classic 5 x 4 minutes at 106 to 112 percent of FTP - about 278 to 293W at your new number - with 4-minute easy spins between, twice a week for the two weeks.

Correct summary:
## Athlete Profile
- FTP 262W (tested this morning, 20min at 276W; up from 255W in March)
- Weight 71kg (down from 73kg in winter); 3.69 W/kg at new FTP
- Goal: Alpine Gran Fondo 1998-08-15, 168km / 3400m climbing, target sub-7 hours
- Availability: 9h/week typical, 11h max, Tuesdays always off
- Left knee: patellar tendon overload last autumn from 3 consecutive interval days; physio-cleared in December; cap at 2 hard days back to back
- Canyon Ultimate + Quarq power meter; Kickr indoors reads ~8W lower than outdoor
- Rides with a fast Thursday group (races up the second climb); counts as a hard day against the knee rule
- Long-ride hydration habit: one electrolyte bottle per hour above 25C, plain water otherwise
## Training Status
- Just completed FTP retest; recovery week next, then a 2-week VO2max block, then sweet spot build toward the Fondo
- VO2max sessions planned: 5 x 4min at 106-112 percent of FTP (about 278-293W), 4min easy between, twice weekly
- This week: two quality sessions, 4.5h long ride Sunday, Tuesday off
## Coach Stance
- Volume: hold at 9h; intensity: structured per plan - grounded in the fresh 262W test and knee history
- Pacing note for next test: start 10W lower (first 5min too hot, faded late)
## Discussion Context
- Last exchange: agreed to insert the VO2max block before the build, as previously discussed
- Zone targets to be recalculated from FTP 262W; apply the 8W offset for indoor sessions
## Pending Questions
- None outstanding

WORKED EXAMPLE 2 - RUNNING, PACE AND INJURY

Transcript:
user: Ran the 10k time trial: 42:30, so about 4:15 per km. Legs felt strong until 8k.
assistant: Nice benchmark - 4:15/km for 42:30. That puts your critical speed estimate around 4:28/km. How was breathing versus legs at the end?
user: Breathing fine, calves cramped a little. Also my easy runs - what pace should they be now?
assistant: With that result, easy runs at 5:20-5:35 per km. The cramping at 8k suggests we also add calf conditioning twice a week.
user: OK. Reminder that I am training for the city half marathon on 1998-10-04, hoping for 1:32.
assistant: 1:32 needs 4:22/km - ambitious but reachable from today's shape with a 10-week build. Long run this weekend: 16k with the last 4k at 4:40/km.
user: My right achilles was sore for two weeks in May after I switched to zero-drop shoes. Fine since I went back to my old Pegasus.
assistant: Logged: achilles flare in May tied to the zero-drop switch, resolved on the Pegasus. Keep racing and long runs in the Pegasus for this cycle - no shoe experiments inside the build.
user: Got it. Weekly mileage is around 52km right now. How high should it go?
assistant: Peak at 65km in week 7, then taper. Progression about 8 percent per week with a cutback in week 4. Does Saturday or Sunday suit the long run better?
user: Sunday. Saturdays I do parkrun with my daughter, easy effort.
assistant: Sunday long runs it is, and the Saturday parkrun stays easy - that is a nice aerobic touch, not a race.
user: Should I keep doing strides? My old plan had them twice a week after easy runs.
assistant: Yes - strides twice a week after easy runs, 6 x 20 seconds with full recovery. They maintain leg speed without loading the achilles the way hill sprints would.

Correct summary:
## Athlete Profile
- 10k time trial 42:30 (4:15/km); critical speed estimate ~4:28/km
- Goal: city half marathon 1998-10-04, target 1:32 (needs 4:22/km)
- Current weekly mileage ~52km; plan peaks at 65km in week 7
- Right achilles soreness for 2 weeks in May from zero-drop shoe switch; resolved on Nike Pegasus; no shoe experiments during this build
- Saturdays: easy parkrun with daughter (fixed); long runs on Sundays
## Training Status
- 10-week half-marathon build under way; easy runs prescribed at 5:20-5:35/km
- Calf cramping at 8k of the time trial; calf conditioning added twice weekly
- Strides kept: twice weekly after easy runs, 6 x 20s with full recovery (safer for the achilles than hills)
- Weekend: 16k long run with last 4k at 4:40/km
## Coach Stance
- Volume: increase ~8 percent weekly with a week-4 cutback to 65km peak - grounded in the 42:30 benchmark and current 52km base
- Intensity: hold to plan; watch calves and achilles
## Discussion Context
- Last exchange: settled the long-run day (Sunday) and parkrun stays easy effort
- Easy-pace and long-run targets set from the new time-trial result
## Pending Questions
- None outstanding

WORKED EXAMPLE 3 - MERGING AN EXISTING SUMMARY WITH A DISPUTE

Existing summary of earlier context (provided in the user message):
## Athlete Profile
- FTP 240W, weight 80kg; goal: first 100-mile sportive in September
- Trains 6h/week, indoor only on weekdays
## Training Status
- Week 1 of base block completed, all sessions done
## Coach Stance
- Volume: hold; intensity: hold - grounded in a clean first week
## Discussion Context
- Setting up the base block structure
## Pending Questions
- Coach asked for a morning resting heart rate baseline; athlete to report

Transcript:
user: Resting HR has been 52-54 all week. But listen, I looked at the plan and I think the weekend ride at 3 hours is too short. My mates ride 5 hours.
assistant: Thanks - 52-54 is a good baseline, logged. On the long ride: at week 2 of base with a 6-hour weekly budget, a 5-hour ride would be 83 percent of your whole week in one session and cost you both weekday workouts. I recommend holding at 3 hours, progressing to 4 by week 6.
user: I still think you are being too cautious. I did 4.5 hours with them last month and felt fine.
assistant: I hear you, and that ride is real evidence you can complete the distance. My concern is the week around it, not the ride itself. Compromise: 3.5 hours this weekend at a strictly easy effort, and if recovery markers stay clean we step up faster.
user: Fine, 3.5 this weekend. But I want to revisit this next week.
assistant: Agreed - we revisit the long-ride progression next week with your recovery data on the table.
user: One more thing - I fitted a saddle bag with a spare tube and a mini pump, so the longer rides can go further from home now.
assistant: Good. Being self-sufficient means route choice no longer limits the long ride; keep that kit on the bike for anything over two hours.

Correct summary:
## Athlete Profile
- FTP 240W, weight 80kg; goal: first 100-mile sportive in September
- Trains 6h/week, indoor only on weekdays
- Morning resting heart rate baseline 52-54
- Saddle bag with spare tube and mini pump fitted; self-sufficient on rides over 2h
## Training Status
- Week 2 of base block; weekend long ride set at 3.5h easy (compromise, up from planned 3h)
## Coach Stance
- Volume: hold with a negotiated step to 3.5h long ride; intensity: hold - grounded in the clean week-1 and the new 52-54 resting HR baseline
- ACTIVE DISPUTE: athlete wants ~5h long rides now (cites a 4.5h ride last month, felt fine); coach recommends progressive build to 4h by week 6; compromise accepted for this weekend only
## Discussion Context
- Last exchange: agreed to revisit the long-ride progression next week using recovery data
- Long-ride progression: 3h -> 3.5h now, target 4h by week 6 if recovery stays clean
## Pending Questions
- Long-ride progression to be revisited next week (athlete explicitly wants this reopened)

FINAL REMINDERS

Every fact in an existing summary survives unless directly superseded - notice how example 3 kept FTP, weight, goal, and weekly hours untouched while adding the new baseline, the new equipment fact, and the dispute. Numbers are copied character for character. Disputes carry both positions and the current resting point. When in doubt about whether a detail matters, keep it: a summary that is 60 words longer is cheap; a lost fact is unrecoverable.`;

export function buildCompactionSystemPrompt(tokens: readonly string[]): string {
  return `${COMPACTION_PROMPT_CORE}\n\n${buildMustPreserveBlock(tokens)}`;
}

function buildUserMessage(
  instruction: string,
  transcriptLabel: string,
  carried: string | undefined,
  transcript: string,
): string {
  return [
    instruction,
    carried !== undefined && carried !== ""
      ? `Existing summary of earlier context:\n${carried}`
      : "",
    `${transcriptLabel}\n${transcript}`,
  ].filter((s) => s !== "").join("\n\n");
}

function buildStagesUserMessage(carried: string | undefined, transcript: string): string {
  return buildUserMessage(
    "Summarize the conversation below into the five required sections.",
    "Messages to summarize:",
    carried,
    transcript,
  );
}

function buildDroppedUserMessage(carried: string | undefined, transcript: string): string {
  return buildUserMessage(
    "Incorporate the older conversation messages below into the existing summary, producing one updated summary with the five required sections.",
    "Messages to incorporate:",
    carried,
    transcript,
  );
}

function buildRestructureUserMessage(missing: string[], best: string): string {
  return `Restructure the following summary to include ALL required section headings: ${missing.join(", ")}.\n\n${best}`;
}

// ============================================================================
// HELPERS
// ============================================================================

// Exported for the compaction quality gate, which must scope its MUST-PRESERVE
// check against the exact transcript text the summarizer prompt carries.
export function formatTranscript(messages: ModelMessage[]): string {
  return messages.map((m) => `${m.role}: ${messageText(m)}`).join("\n");
}

function capSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return truncateUtf16Safe(summary, MAX_SUMMARY_CHARS) + SUMMARY_TRUNCATED_MARKER;
}

async function generateSummaryWithTimeout(
  llm: LLM,
  opts: {
    system: string;
    userContent: string;
    maxOutputTokens: number;
    caller?: GenerateOptions["caller"];
    budget?: GenerateCallCharger;
  },
): Promise<string> {
  const { budget, system, userContent, ...rest } = opts;
  budget?.chargeGenerateCall();
  const { text } = await llm.generate({
    system,
    messages: [{ role: "user", content: userContent }],
    deadlineMs: SUMMARIZATION_TIMEOUT_MS,
    ...rest,
  });
  return text;
}

export function computeAdaptiveChunkRatio(
  messages: ModelMessage[],
  contextWindowTokens: number,
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindowTokens;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

export function chunkMessagesByMaxTokens(
  messages: ModelMessage[],
  maxTokens: number,
): ModelMessage[][] {
  if (messages.length === 0) return [];

  const safeMax = Math.floor(maxTokens / SAFETY_MARGIN);
  const chunks: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(messageText(msg));

    if (currentTokens + msgTokens > safeMax && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

function computeAdaptiveChunks(
  messages: ModelMessage[],
  contextWindowTokens?: number,
): ModelMessage[][] {
  if (messages.length === 0) return [];
  const ctxWindow = contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
  const adaptiveRatio = computeAdaptiveChunkRatio(messages, ctxWindow);
  const maxChunkTokens = Math.max(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.floor(ctxWindow * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
  );
  return chunkMessagesByMaxTokens(messages, maxChunkTokens);
}

// ============================================================================
// QUALITY AUDIT
// ============================================================================

export function auditSummaryQuality(summary: string): { ok: boolean; missing: string[] } {
  const lower = summary.toLowerCase();
  const missing = REQUIRED_SUMMARY_SECTIONS.filter(
    (section) => !lower.includes(section.toLowerCase()),
  );
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

async function finalizeSummary(params: {
  summary: string;
  llm: LLM;
  system: string;
  maxRetries: number;
  caller?: GenerateOptions["caller"];
  budget?: GenerateCallCharger;
}): Promise<string> {
  const { llm, system, maxRetries, caller, budget } = params;
  let best = capSummary(params.summary);
  const audit = auditSummaryQuality(best);
  if (audit.ok) return best;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const text = await generateSummaryWithTimeout(llm, {
        system,
        userContent: buildRestructureUserMessage(audit.missing, best),
        maxOutputTokens: MAX_SUMMARY_TOKENS,
        caller,
        budget,
      });
      const capped = capSummary(text);
      if (auditSummaryQuality(capped).ok) return capped;
      best = capped;
    } catch (err) {
      console.warn("Summary audit retry failed", err);
    }
  }

  return best;
}

// ============================================================================
// DROPPED MESSAGE SUMMARIZATION
// ============================================================================

export async function summarizeDroppedMessages(params: {
  dropped: ModelMessage[];
  llm: LLM;
  mustPreserveTokens: SportMemoryShape["mustPreserveTokens"];
  memory: MemorySnapshot;
  previousSummary?: string;
  previousSummaryProvenance?: SourceProvenance;
  maxRetries?: number;
  contextWindowTokens?: number;
  caller?: GenerateOptions["caller"];
  budget?: GenerateCallCharger;
}): Promise<{
  summary: string;
  unsummarized: ModelMessage[];
  provenance?: SourceProvenance;
}> {
  const { dropped, llm, mustPreserveTokens, memory, previousSummary, previousSummaryProvenance, maxRetries = 1, contextWindowTokens, caller, budget } = params;

  if (dropped.length === 0) return { summary: previousSummary ?? "", unsummarized: [] };

  const { tokens, provenance: tokenProvenance } = resolveTokens(mustPreserveTokens, memory);
  const system = buildCompactionSystemPrompt(tokens);

  const chunks = computeAdaptiveChunks(dropped, contextWindowTokens);
  // Fallback: if adaptive chunking returns empty (shouldn't happen), use single chunk
  if (chunks.length === 0) chunks.push(dropped);

  let summary: string | undefined;
  let summaryProvenance = unionProvenance(
    previousSummary === undefined ? undefined : (previousSummaryProvenance ?? UNKNOWN_PROVENANCE),
    tokenProvenance,
  );
  const unsummarized: ModelMessage[] = [];
  let lastError: unknown;

  for (const [index, chunk] of chunks.entries()) {
    const transcript = formatTranscript(chunk);
    const carriedSummary = summary ?? previousSummary;

    try {
      const text = await generateSummaryWithTimeout(llm, {
        system,
        userContent: buildDroppedUserMessage(carriedSummary, transcript),
        maxOutputTokens: MAX_SUMMARY_TOKENS,
        caller,
        budget,
      });
      summary = text;
      summaryProvenance = unionProvenance(summaryProvenance, provenanceOfMessages(chunk));
    } catch (err) {
      lastError = err;
      unsummarized.push(...chunks.slice(index).flat());
      console.warn("Dropped message summarization LLM call failed, using fallback", err);
      break;
    }
  }

  if (summary === undefined) {
    throw new Error("Dropped message summarization failed before any chunk was summarized", {
      cause: lastError,
    });
  }

  return {
    summary: await finalizeSummary({ summary, llm, system, maxRetries, caller, budget }),
    unsummarized,
    provenance: summaryProvenance,
  };
}

// ============================================================================
// SUMMARIZE IN STAGES
// ============================================================================

export async function summarizeInStages(params: {
  messages: ModelMessage[];
  llm: LLM;
  mustPreserveTokens: SportMemoryShape["mustPreserveTokens"];
  memory: MemorySnapshot;
  recentToKeep?: number;
  previousSummary?: string;
  contextWindowTokens?: number;
  caller?: GenerateOptions["caller"];
  budget?: GenerateCallCharger;
}): Promise<{ messages: ModelMessage[]; summary?: string; summaryProvenance?: SourceProvenance }> {
  const { llm, mustPreserveTokens, memory, recentToKeep = 4, contextWindowTokens, caller, budget } = params;

  let messages = params.messages;
  let previousSummary = params.previousSummary;
  let previousSummaryProvenance: SourceProvenance | undefined;
  const first = messages[0];
  if (
    previousSummary === undefined &&
    first !== undefined &&
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.startsWith(SUMMARY_PREFIX)
  ) {
    previousSummary = first.content.slice(SUMMARY_PREFIX.length + 1);
    previousSummaryProvenance = getMessageProvenance(first);
    messages = messages.slice(1);
  }

  const keepCount = Math.min(recentToKeep, messages.length);
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const recent = messages.slice(messages.length - keepCount);
  let summaryProvenance =
    previousSummary === undefined ? undefined : (previousSummaryProvenance ?? UNKNOWN_PROVENANCE);

  if (toSummarize.length === 0) {
    return { messages: params.messages };
  }

  const { tokens, provenance: tokenProvenance } = resolveTokens(mustPreserveTokens, memory);
  summaryProvenance = unionProvenance(summaryProvenance, tokenProvenance);
  const system = buildCompactionSystemPrompt(tokens);

  const chunks = computeAdaptiveChunks(toSummarize, contextWindowTokens);

  // Thread previousSummary through chunk loop
  let summary = previousSummary;
  const unsummarized: ModelMessage[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const transcript = formatTranscript(chunk);

    try {
      const text = await generateSummaryWithTimeout(llm, {
        system,
        userContent: buildStagesUserMessage(summary, transcript),
        maxOutputTokens: MAX_SUMMARY_TOKENS,
        caller,
        budget,
      });
      summary = text;
      summaryProvenance = unionProvenance(summaryProvenance, provenanceOfMessages(chunk));
    } catch (err) {
      unsummarized.push(...chunks.slice(index).flat());
      console.warn("Staged summarization chunk failed; retaining original messages", err);
      break;
    }
  }

  if (summary === undefined || unsummarized.length === toSummarize.length) {
    return {
      messages: [
        ...(previousSummary === undefined
          ? []
          : [makeSummaryMessage(previousSummary, previousSummaryProvenance ?? UNKNOWN_PROVENANCE)]),
        ...messages,
      ],
    };
  }

  const finalSummary = await finalizeSummary({
    summary,
    llm,
    system,
    maxRetries: 1,
    caller,
    budget,
  });
  const durableProvenance = summaryProvenance ?? UNKNOWN_PROVENANCE;
  return {
    messages: [makeSummaryMessage(finalSummary, durableProvenance), ...unsummarized, ...recent],
    summary: finalSummary,
    summaryProvenance: durableProvenance,
  };
}

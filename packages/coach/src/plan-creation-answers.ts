import {
  PLAN_CREATION_ANSWER_KEYS,
  PlanCreationAnswerSchema,
  PlanCreationCardModelSchema,
  PlanCreationDraftSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswer,
  type PlanCreationCommitmentRule,
  type PlanCreationPendingCommitment,
  type PlanCreationAnswerSummary,
  type PlanCreationCardModel,
  type PlanCreationGoal,
  type PlanCreationOpenQuestion,
} from "@enduragent/coach-contract";
import { interpretCommitments, type CreationDraftInput } from "@enduragent/sport-cycling";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCreationStoreError,
  type PlanCreationAnswerRecord,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";

export type PlanCreationAnswerKey = (typeof PLAN_CREATION_ANSWER_KEYS)[number];

export type PlanCreationAnswerSource =
  | { readonly kind: "athlete" }
  | { readonly kind: "derived"; readonly label: string };

export interface PlanCreationBaselineEvidence {
  readonly baseline: "regular" | "occasional" | "starting-again";
  readonly label: string;
}

export interface PlanCreationProjectionContext {
  readonly today: string;
}

export interface StoredPlanCreationAnswer {
  readonly answer: PlanCreationAnswer;
  readonly source: PlanCreationAnswerSource;
  readonly record: PlanCreationAnswerRecord;
}

export interface PlanCreationAnswerFlow {
  readonly order: readonly PlanCreationAnswerKey[];
  readonly latest: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly valid: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly next: PlanCreationAnswerKey | null;
}

const corrupt = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : corrupt();

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isAnswerKey = (value: string): value is PlanCreationAnswerKey =>
  (PLAN_CREATION_ANSWER_KEYS as readonly string[]).includes(value);

const parseSource = (value: unknown): PlanCreationAnswerSource => {
  const candidate = object(value);
  if (candidate.kind === "athlete" && hasExactKeys(candidate, ["kind"])) {
    return { kind: "athlete" };
  }
  if (
    candidate.kind === "derived" &&
    typeof candidate.label === "string" &&
    hasExactKeys(candidate, ["kind", "label"])
  ) {
    return { kind: "derived", label: candidate.label };
  }
  return corrupt();
};

const parseStoredAnswer = (record: PlanCreationAnswerRecord): StoredPlanCreationAnswer => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(record.valueJson) as unknown;
  } catch {
    return corrupt();
  }
  const stored = object(decoded);
  if (!isAnswerKey(record.answerKey)) return corrupt();
  if (hasExactKeys(stored, ["answer", "source"])) {
    const answer = PlanCreationAnswerSchema.safeParse(stored.answer);
    if (!answer.success || answer.data.kind !== record.answerKey) return corrupt();
    return { answer: answer.data, source: parseSource(stored.source), record };
  }
  const legacyAnswer = PlanCreationAnswerSchema.safeParse(stored);
  if (!legacyAnswer.success || legacyAnswer.data.kind !== record.answerKey) return corrupt();
  return { answer: legacyAnswer.data, source: { kind: "athlete" }, record };
};

export const encodePlanCreationAnswer = (
  answer: PlanCreationAnswer,
  source: PlanCreationAnswerSource,
): string => canonicalJson({ answer, source });

export const readPlanCreationAnswers = (
  snapshot: PlanCreationSnapshot,
): readonly StoredPlanCreationAnswer[] => snapshot.answers.map(parseStoredAnswer);

export function validateCommitmentInterpretation(text: string) {
  const interpreted = interpretCommitments(text);
  return interpreted.rules.length > 20
    ? {
        ...interpreted,
        status: "clarify" as const,
        unparsed: ["Keep it to a few limits at a time."],
      }
    : interpreted;
}

export function pendingPlanCreationCommitment(
  snapshot: PlanCreationSnapshot,
): PlanCreationPendingCommitment | null {
  const latest = readPlanCreationAnswers(snapshot)
    .filter(({ answer }) => answer.kind === "commitments")
    .at(-1)?.answer;
  if (
    latest?.kind !== "commitments" ||
    latest.commitments.kind !== "interpreted" ||
    latest.commitments.status === "confirmed"
  )
    return null;
  const interpreted = validateCommitmentInterpretation(latest.commitments.text);
  return latest.commitments.rules.length === 0 && interpreted.status === "confirm"
    ? {
        text: latest.commitments.text,
        rules: [],
        status: "clarify",
        unparsed: [latest.commitments.text],
      }
    : { text: latest.commitments.text, ...interpreted };
}

const confirmedCommitments = (
  snapshot: PlanCreationSnapshot,
): Extract<PlanCreationAnswer, { kind: "commitments" }> => {
  for (const { answer } of [...readPlanCreationAnswers(snapshot)].reverse()) {
    if (
      answer.kind === "commitments" &&
      (answer.commitments.kind === "none" || answer.commitments.status === "confirmed")
    )
      return answer;
  }
  return { kind: "commitments", commitments: { kind: "none" } };
};

export function interpretCommitmentMessage(text: string): PlanCreationAnswerInput | null {
  const parsed = validateCommitmentInterpretation(text);
  return parsed.status === "confirm"
    ? { kind: "commitments", commitments: { kind: "interpreted", text } }
    : null;
}

export function resolvePlanCreationAnswer(
  snapshot: PlanCreationSnapshot,
  answer: PlanCreationAnswerInput,
): PlanCreationAnswer | null {
  if (answer.kind === "commitments-cancel") {
    return pendingPlanCreationCommitment(snapshot) === null ? null : confirmedCommitments(snapshot);
  }
  if (answer.kind === "commitments-confirm") {
    const pending = pendingPlanCreationCommitment(snapshot);
    return pending?.status !== "confirm"
      ? null
      : {
          kind: "commitments",
          commitments: {
            kind: "interpreted",
            text: pending.text,
            rules: pending.rules,
            status: "confirmed",
          },
        };
  }
  if (
    answer.kind === "commitments-interpret" ||
    (answer.kind === "commitments" && answer.commitments.kind === "interpreted")
  ) {
    const text =
      answer.kind === "commitments-interpret"
        ? answer.text
        : answer.commitments.kind === "interpreted"
          ? answer.commitments.text
          : corrupt();
    return {
      kind: "commitments",
      commitments: {
        kind: "interpreted",
        text,
        rules: interpretCommitments(text).rules,
        status: "clarify",
      },
    };
  }
  return answer.kind === "commitments"
    ? { kind: "commitments", commitments: { kind: "none" } }
    : answer;
}

const commitmentRuleDetail = (rule: PlanCreationCommitmentRule): string => {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (rule.kind === "time-off") {
    const format = (date: string): string => {
      const [year, month, day] = date.split("-");
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
    };
    return `Off ${format(rule.start)} to ${format(rule.end)}`;
  }
  const day = days[rule.day - 1];
  if (rule.kind === "weekday-duration") return `${day} · at most ${rule.minutes} min`;
  if (rule.kind === "weekday-unavailable") return `${day} · unavailable`;
  return `${day} · no hard training`;
};

const commitmentRulesDetail = (rules: readonly PlanCreationCommitmentRule[]): string => {
  let detail = "";
  for (const [index, rule] of rules.entries()) {
    const next = [detail, commitmentRuleDetail(rule)].filter(Boolean).join("; ");
    const remaining = rules.length - index - 1;
    const suffix = remaining > 0 ? ` · and ${remaining} more` : "";
    if (next.length + suffix.length > 2_000) return `${detail} · and ${rules.length - index} more`;
    detail = next;
  }
  return detail;
};

type PlanCreationGoalFamily = "event" | "fitness";

const goalFamily = (
  answer: Extract<PlanCreationAnswer, { kind: "goal" }>,
): PlanCreationGoalFamily => (answer.goal.kind === "fitness" ? "fitness" : "event");

const currentGoalRunStart = (
  answers: readonly StoredPlanCreationAnswer[],
): { readonly family: PlanCreationGoalFamily; readonly sequence: number } | undefined => {
  const goals = answers.filter(
    (
      stored,
    ): stored is StoredPlanCreationAnswer & {
      readonly answer: Extract<PlanCreationAnswer, { kind: "goal" }>;
    } => stored.answer.kind === "goal",
  );
  const current = goals.at(-1);
  if (current === undefined) return undefined;
  const family = goalFamily(current.answer);
  let sequence = current.record.sequence;
  for (let index = goals.length - 2; index >= 0; index -= 1) {
    const prior = goals[index]!;
    if (goalFamily(prior.answer) !== family) break;
    sequence = prior.record.sequence;
  }
  return { family, sequence };
};

const currentScheduleModeRunStart = (
  answers: readonly StoredPlanCreationAnswer[],
): { readonly mode: "fixed" | "flexible"; readonly sequence: number } | undefined => {
  const modes = answers.filter(
    (
      stored,
    ): stored is StoredPlanCreationAnswer & {
      readonly answer: Extract<PlanCreationAnswer, { kind: "schedule-mode" }>;
    } => stored.answer.kind === "schedule-mode",
  );
  const current = modes.at(-1);
  if (current === undefined) return undefined;
  const mode = current.answer.mode;
  let sequence = current.record.sequence;
  for (let index = modes.length - 2; index >= 0; index -= 1) {
    const prior = modes[index]!;
    if (prior.answer.mode !== mode) break;
    sequence = prior.record.sequence;
  }
  return { mode, sequence };
};

export function resolvePlanCreationAnswerFlow(
  snapshot: PlanCreationSnapshot,
): PlanCreationAnswerFlow {
  const answers = readPlanCreationAnswers(snapshot);
  const latest = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const stored of answers) latest.set(stored.answer.kind, stored);
  const goalRun = currentGoalRunStart(answers);
  const scheduleModeRun = currentScheduleModeRunStart(answers);
  const order: readonly PlanCreationAnswerKey[] =
    goalRun?.family === "fitness"
      ? [
          "goal",
          "plan-length",
          "schedule-mode",
          "availability",
          "start-timing",
          "commitments",
          "baseline",
          "success",
          "restriction",
        ]
      : goalRun !== undefined
        ? [
            "goal",
            "schedule-mode",
            "availability",
            "start-timing",
            "commitments",
            "baseline",
            "success",
            "restriction",
          ]
        : ["goal"];
  const valid = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const key of order) {
    const stored = latest.get(key);
    if (stored === undefined) continue;
    if (key === "success") {
      const matchesGoal =
        goalRun?.family === "fitness"
          ? stored.answer.kind === "success" &&
            (stored.answer.success.kind === "fitness-choice" ||
              stored.answer.success.kind === "authored")
          : goalRun !== undefined
            ? stored.answer.kind === "success" &&
              (stored.answer.success.kind === "event-finish" ||
                stored.answer.success.kind === "authored")
            : false;
      if (!matchesGoal || goalRun === undefined || stored.record.sequence <= goalRun.sequence) {
        continue;
      }
    }
    if (
      key === "plan-length" &&
      (goalRun?.family !== "fitness" || stored.record.sequence <= goalRun.sequence)
    ) {
      continue;
    }
    if (key === "availability") {
      if (
        stored.answer.kind !== "availability" ||
        scheduleModeRun === undefined ||
        stored.answer.mode !== scheduleModeRun.mode ||
        stored.record.sequence <= scheduleModeRun.sequence
      ) {
        continue;
      }
    }
    valid.set(key, stored);
  }
  return { order, latest, valid, next: order.find((key) => !valid.has(key)) ?? null };
}

const required = (
  flow: PlanCreationAnswerFlow,
  key: PlanCreationAnswerKey,
): StoredPlanCreationAnswer => flow.valid.get(key) ?? corrupt();

const requireGoal = (flow: PlanCreationAnswerFlow): PlanCreationGoal => {
  const answer = required(flow, "goal").answer;
  return answer.kind === "goal" ? answer.goal : corrupt();
};

const hours = (value: number): string => `${value} h`;

const baselineDetail = (baseline: "regular" | "occasional" | "starting-again"): string => {
  if (baseline === "regular") return "Training regularly";
  if (baseline === "occasional") return "Training occasionally";
  return "Starting again";
};

function goalDetail(snapshot: PlanCreationSnapshot, goal: PlanCreationGoal): string {
  if (goal.kind === "fitness") {
    return goal.outcome ?? "Build fitness for a fixed number of weeks.";
  }
  if (goal.kind === "event-manual") return `${goal.name} · ${goal.date}`;
  const candidate = snapshot.seed?.eventCandidates.find(
    (item) => item.candidateId === goal.candidateId,
  );
  if (candidate === undefined) return corrupt();
  return `${candidate.name} · ${candidate.date} · ${candidate.sourceLabel}`;
}

const successDetail = (answer: Extract<PlanCreationAnswer, { kind: "success" }>): string => {
  if (answer.success.kind === "authored") return answer.success.text;
  if (answer.success.kind === "fitness-choice") {
    if (answer.success.choice === "train-consistently") return "Train consistently";
    if (answer.success.choice === "climb-stronger") return "Climb stronger";
    return "Ride farther comfortably";
  }
  if (answer.success.choice === "finish-comfortably") return "Finish comfortably";
  if (answer.success.choice === "finish-fast") return "Finish fast";
  return "Race for a result";
};

const availabilityDetail = (
  answer: Extract<PlanCreationAnswer, { kind: "availability" }>,
): string => {
  const limits = `Up to ${hours(answer.weeklyHoursLimit)} a week, longest Workout ${hours(answer.longestWorkoutHours)}`;
  if (answer.mode === "flexible") {
    const poolSize = answer.weeklyHoursLimit <= 6 ? 3 : answer.weeklyHoursLimit <= 8 ? 4 : 5;
    return `${limits}, ${poolSize} Workouts in the flexible pool`;
  }
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekdays = [...answer.usableWeekdays]
    .sort((left, right) => left - right)
    .map((weekday) => names[weekday - 1])
    .join(" ");
  return `${limits}, ${weekdays}`;
};

const restrictionDetail = (
  restriction: Extract<PlanCreationAnswer, { kind: "restriction" }>["restriction"],
): string => {
  if (restriction.kind === "none") return "No training restrictions";
  const end = restriction.endDate === undefined ? "" : ` until ${restriction.endDate}`;
  if (restriction.kind === "no-training") return `No training${end}`;
  if (restriction.kind === "no-hard-training") return `No hard training${end}`;
  return `Maximum Workout duration ${hours(restriction.hours)}${end}`;
};

function answerSummary(
  snapshot: PlanCreationSnapshot,
  stored: StoredPlanCreationAnswer,
  question: PlanCreationOpenQuestion,
): PlanCreationAnswerSummary {
  const answer = stored.answer;
  const shared = { answerKey: answer.kind, question, answer, source: stored.source };
  switch (answer.kind) {
    case "goal":
      return { ...shared, title: "Goal", detail: goalDetail(snapshot, answer.goal) };
    case "success":
      return { ...shared, title: "Success", detail: successDetail(answer) };
    case "plan-length":
      return { ...shared, title: "Plan length", detail: `${answer.weeks} weeks` };
    case "start-timing":
      return {
        ...shared,
        title: "Start timing",
        detail:
          answer.timing.kind === "as-soon-as-possible"
            ? "As soon as possible"
            : `Earliest start ${answer.timing.date}`,
      };
    case "schedule-mode":
      return {
        ...shared,
        title: "Schedule mode",
        detail: answer.mode === "fixed" ? "Fixed Schedule" : "Flexible Schedule",
      };
    case "availability":
      return { ...shared, title: "Availability", detail: availabilityDetail(answer) };
    case "commitments":
      return {
        ...shared,
        title: "Commitments",
        detail:
          answer.commitments.kind === "none"
            ? "No fixed commitments, other training, or time off"
            : answer.commitments.rules.length === 0
              ? answer.commitments.text
              : commitmentRulesDetail(answer.commitments.rules),
      };
    case "baseline":
      return {
        ...shared,
        title: "Training baseline",
        detail: baselineDetail(answer.baseline),
      };
    case "restriction":
      return {
        ...shared,
        title: "Training Restriction",
        detail: restrictionDetail(answer.restriction),
      };
  }
}

function questionForKey(
  snapshot: PlanCreationSnapshot,
  flow: PlanCreationAnswerFlow,
  context: PlanCreationProjectionContext,
  key: PlanCreationAnswerKey,
): PlanCreationOpenQuestion {
  const step = {
    current: flow.order.indexOf(key) + 1,
    total: flow.order.length === 1 ? 9 : flow.order.length,
  };
  switch (key) {
    case "goal":
      return {
        kind: "goal-question",
        step,
        prompt: "What do you want this Plan to prepare you for?",
        candidates: [...(snapshot.seed?.eventCandidates ?? [])],
        eventNotListedOption: {
          label: "Event not listed",
          detail: "Tell me the event name and its exact date.",
          editorLabel: "Name the event and include its exact date.",
          placeholder: "Event name",
          nameLabel: "Event name",
          dateLabel: "Event date",
        },
        fitnessOption: {
          label: "Improve without an event",
          detail: "Build fitness for a fixed number of weeks.",
        },
        authoredOption: {
          label: "Something else",
          detail: "Answer in your own words.",
          editorLabel: "Name the event and include its exact date.",
          placeholder: "Event name",
        },
      };
    case "success":
      return requireGoal(flow).kind === "fitness"
        ? {
            kind: "success-question",
            step,
            prompt: "What would success mean for this Fitness Goal?",
            input: {
              kind: "fitness-choice",
              options: [
                {
                  choice: "train-consistently",
                  label: "Train consistently",
                  detail: "Complete most planned weeks without forcing missed Workouts back in.",
                },
                {
                  choice: "climb-stronger",
                  label: "Climb stronger",
                  detail: "Hold a steadier effort on longer climbs.",
                },
                {
                  choice: "ride-farther",
                  label: "Ride farther comfortably",
                  detail: "Finish longer rides with stable energy and form.",
                },
              ],
              authored: {
                label: "Something else",
                detail: "Answer in your own words.",
                editorLabel: "Describe what success looks like at the end of this Plan.",
              },
              placeholder: "Describe what success would look like",
            },
          }
        : {
            kind: "success-question",
            step,
            prompt: "What would success mean for this Event Goal?",
            input: {
              kind: "event-finish",
              options: [
                {
                  choice: "finish-comfortably",
                  label: "Finish comfortably",
                  detail: "Complete the event with enough left to enjoy the final hour.",
                },
                {
                  choice: "finish-fast",
                  label: "Finish fast",
                  detail: "Hold a strong pace and finish the final climbs well.",
                },
                {
                  choice: "race-for-result",
                  label: "Race for a result",
                  detail: "Prepare for the strongest result your current training supports.",
                },
              ],
              authored: {
                label: "Something else",
                detail: "Answer in your own words.",
                editorLabel: "Describe what a successful event would feel like.",
                placeholder: "Describe what success would look like",
              },
            },
          };
    case "plan-length":
      return {
        kind: "plan-length-question",
        step,
        prompt: "How long should this Fitness Plan be?",
        options: [
          { weeks: 4, label: "4 weeks", detail: "A short, focused block." },
          { weeks: 8, label: "8 weeks", detail: "One full training cycle." },
          { weeks: 12, label: "12 weeks", detail: "Room for steady progression." },
          { weeks: 16, label: "16 weeks", detail: "The longest steady build." },
        ],
      };
    case "start-timing":
      return {
        kind: "start-timing-question",
        step,
        prompt: "When could this Plan start?",
        earliestAllowed: context.today,
        options: [
          {
            timing: "as-soon-as-possible",
            label: "As soon as possible",
            detail: "Start with the earliest suitable training week.",
          },
          {
            timing: "earliest",
            label: "From a date",
            detail: "Set the earliest date this Plan may begin.",
          },
        ],
        dateLabel: "Earliest start date",
      };
    case "schedule-mode":
      return {
        kind: "schedule-mode-question",
        step,
        prompt: "How should Workouts fit into your week?",
        options: [
          {
            mode: "fixed",
            label: "Same days every week",
            detail: "Workouts land on the days you pick.",
          },
          {
            mode: "flexible",
            label: "My week varies",
            detail: "Pick from a weekly pool when you ride.",
          },
        ],
      };
    case "availability": {
      const scheduleMode = required(flow, "schedule-mode").answer;
      if (scheduleMode.kind !== "schedule-mode") return corrupt();
      return {
        kind: "availability-question",
        step,
        prompt: "How much training fits in a usual week?",
        mode: scheduleMode.mode,
        weeklyHoursOptions: [
          {
            id: "hours-6",
            weeklyHoursLimit: 6,
            label: "5–6 hours",
            detail: "Up to about six hours of riding a week.",
          },
          {
            id: "hours-8",
            weeklyHoursLimit: 8,
            label: "7–8 hours",
            detail: "Up to about eight hours of riding a week.",
          },
          {
            id: "hours-10",
            weeklyHoursLimit: 10,
            label: "9+ hours",
            detail: "About nine hours or more of riding a week.",
          },
        ],
        longestWorkoutLabel: "Longest ride in hours",
        weekdayOptions: [
          { weekday: 1, label: "Mon" },
          { weekday: 2, label: "Tue" },
          { weekday: 3, label: "Wed" },
          { weekday: 4, label: "Thu" },
          { weekday: 5, label: "Fri" },
          { weekday: 6, label: "Sat" },
          { weekday: 7, label: "Sun" },
        ],
        derivedPoolNote:
          scheduleMode.mode === "flexible"
            ? "Your weekly limit sets 3 Workouts up to 6 h, 4 up to 8 h, or 5 above 8 h."
            : "Choose every weekday you can usually train.",
      };
    }
    case "commitments":
      return {
        kind: "commitments-question",
        step,
        prompt: "Any fixed commitments, other training, or time off to account for?",
        noneOption: {
          label: "Nothing fixed",
          detail: "No fixed commitments, other training, or time off to account for.",
        },
        authoredOption: {
          label: "Something else",
          detail: "Add scheduling details in your own words.",
          editorLabel: "Scheduling details",
          placeholder: "Add only the scheduling details this Plan should account for",
        },
      };
    case "baseline":
      return {
        kind: "baseline-question",
        step,
        prompt: "What best describes your recent training?",
        options: [
          {
            baseline: "regular",
            label: "Regular",
            detail: "I have been training consistently.",
          },
          {
            baseline: "occasional",
            label: "Occasional",
            detail: "I have trained some weeks but not consistently.",
          },
          {
            baseline: "starting-again",
            label: "Starting again",
            detail: "I need a conservative return to regular training.",
          },
        ],
      };
    case "restriction":
      return {
        kind: "restriction-question",
        step,
        prompt: "What Training Restriction should this Plan respect?",
        options: [
          {
            kind: "none",
            label: "No training restrictions",
            detail: "No temporary operational limit needs to shape this Plan.",
          },
          {
            kind: "no-training",
            label: "No training for now",
            detail: "Keep all Workouts out until the restriction changes.",
          },
          {
            kind: "no-hard-training",
            label: "No hard training for now",
            detail: "Keep intensity out until the restriction changes.",
          },
          {
            kind: "max-duration",
            label: "I have a duration limit",
            detail: "Set the longest Workout the Plan may use.",
          },
        ],
      };
  }
}

export function projectPlanCreationAnswerSummaries(
  snapshot: PlanCreationSnapshot,
  flow: PlanCreationAnswerFlow,
  context: PlanCreationProjectionContext,
): PlanCreationAnswerSummary[] {
  return flow.order.flatMap((key) => {
    const stored = flow.valid.get(key);
    return stored === undefined
      ? []
      : [answerSummary(snapshot, stored, questionForKey(snapshot, flow, context, key))];
  });
}

export function isPlanCreationDraftCurrent(
  snapshot: PlanCreationSnapshot,
  inputVersion = snapshot.currentDraft?.inputVersion,
): boolean {
  if (inputVersion === undefined) return false;
  if (inputVersion + 1 === snapshot.version) return true;
  const original = resolvePlanCreationDraftAnswers({
    ...snapshot,
    answers: snapshot.answers.filter((answer) => answer.creationVersion <= inputVersion),
  });
  const current = resolvePlanCreationDraftAnswers(snapshot);
  return (
    original !== null && current !== null && canonicalJson(original) === canonicalJson(current)
  );
}

export function projectPlanCreationCard(
  snapshot: PlanCreationSnapshot,
  context: PlanCreationProjectionContext = {
    today: new Date().toISOString().slice(0, 10),
  },
): PlanCreationCardModel {
  if (snapshot.status !== "in-progress" && snapshot.status !== "review") return corrupt();
  const flow = resolvePlanCreationAnswerFlow(snapshot);
  const question = flow.next === null ? null : questionForKey(snapshot, flow, context, flow.next);
  return PlanCreationCardModelSchema.parse({
    creationId: snapshot.id,
    version: snapshot.version,
    status: snapshot.status,
    draft:
      snapshot.currentDraft === null
        ? null
        : PlanCreationDraftSchema.parse(JSON.parse(snapshot.currentDraft.outputSnapshotJson)),
    draftStale: snapshot.currentDraft !== null && !isPlanCreationDraftCurrent(snapshot),
    pendingCommitment: pendingPlanCreationCommitment(snapshot),
    readiness: question === null ? "ready" : "incomplete",
    answeredSummaries: projectPlanCreationAnswerSummaries(snapshot, flow, context),
    openQuestion: question,
  });
}

export function validPlanCreationAnswer(
  snapshot: PlanCreationSnapshot,
  flow: PlanCreationAnswerFlow,
  answer: PlanCreationAnswer,
  today: string,
): boolean {
  if (answer.kind === "commitments") {
    return answer.commitments.kind === "none" || answer.commitments.rules.length <= 20;
  }
  if (answer.kind === "goal") {
    const candidateId = answer.goal.kind === "event-candidate" ? answer.goal.candidateId : null;
    return (
      candidateId === null ||
      snapshot.seed?.eventCandidates.some((candidate) => candidate.candidateId === candidateId) ===
        true
    );
  }
  if (answer.kind === "success") {
    const goal = requireGoal(flow);
    return goal.kind === "fitness"
      ? answer.success.kind === "fitness-choice" || answer.success.kind === "authored"
      : answer.success.kind === "event-finish" || answer.success.kind === "authored";
  }
  if (answer.kind === "plan-length") return requireGoal(flow).kind === "fitness";
  if (answer.kind === "start-timing") {
    return answer.timing.kind === "as-soon-as-possible" || answer.timing.date >= today;
  }
  if (answer.kind === "availability") {
    const scheduleMode = flow.valid.get("schedule-mode")?.answer;
    return scheduleMode?.kind === "schedule-mode" && answer.mode === scheduleMode.mode;
  }
  if (answer.kind === "restriction") {
    return answer.restriction.kind === "none" || answer.restriction.endDate === undefined
      ? true
      : answer.restriction.endDate >= today;
  }
  return true;
}

export function resolvePlanCreationDraftAnswers(
  snapshot: PlanCreationSnapshot,
): CreationDraftInput["answers"] | null {
  const flow = resolvePlanCreationAnswerFlow(snapshot);
  if (flow.next !== null) return null;
  const goalAnswer = flow.valid.get("goal")?.answer;
  const length = flow.valid.get("plan-length")?.answer;
  const availability = flow.valid.get("availability")?.answer;
  const startTiming = flow.valid.get("start-timing")?.answer;
  const commitments = confirmedCommitments(snapshot);
  const baseline = flow.valid.get("baseline")?.answer;
  const success = flow.valid.get("success")?.answer;
  const restriction = flow.valid.get("restriction")?.answer;
  if (
    goalAnswer?.kind !== "goal" ||
    availability?.kind !== "availability" ||
    startTiming?.kind !== "start-timing" ||
    commitments?.kind !== "commitments" ||
    baseline?.kind !== "baseline" ||
    success?.kind !== "success" ||
    restriction?.kind !== "restriction"
  )
    return corrupt();
  const goal = goalAnswer.goal;
  const normalizedGoal = (): CreationDraftInput["answers"]["goal"] => {
    if (goal.kind === "fitness") {
      if (length?.kind !== "plan-length") return corrupt();
      return { ...goal, weeks: length.weeks };
    }
    if (goal.kind === "event-manual") return { kind: "event", name: goal.name, date: goal.date };
    const candidate = snapshot.seed?.eventCandidates.find(
      (value) => value.candidateId === goal.candidateId,
    );
    return candidate === undefined
      ? corrupt()
      : { kind: "event", name: candidate.name, date: candidate.date };
  };
  const { kind: _kind, ...schedule } = availability;
  return {
    goal: normalizedGoal(),
    availability: schedule,
    startTiming: startTiming.timing,
    commitments: commitments.commitments,
    baseline: baseline.baseline,
    success: success.success,
    restriction: restriction.restriction,
  };
}

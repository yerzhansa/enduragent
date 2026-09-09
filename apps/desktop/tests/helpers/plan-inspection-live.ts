import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AthleteState } from "@enduragent/coach-contract";
import type { DesktopFixtureScript, RunningDesktopFixture } from "./desktop-fixture.js";
import { launchDesktopFixture } from "./desktop-fixture.js";
import { PLAN_QA_ATHLETE_STATE } from "./inspection-athlete-states.js";
import { createPlanQaFixtureScript } from "./plan-qa-live.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./training-current-athlete-state.js";
import { TRAINING_INCOMPLETE_ATHLETE_STATE } from "./training-incomplete-athlete-state.js";
import { TRAINING_LIMITED_ATHLETE_STATE } from "./training-limited-athlete-state.js";
import { TRAINING_NO_POWER_ATHLETE_STATE } from "./training-no-power-athlete-state.js";
import { TRAINING_STALE_ATHLETE_STATE } from "./training-stale-athlete-state.js";

export const PLAN_INSPECTION_SCENARIO_ID = "PL-S004";
export const PLAN_CURRENT_INSPECTION_FIXTURE = "plan-current";
export const TRAINING_CURRENT_INSPECTION_FIXTURE = "training-current";
export const TRAINING_NO_POWER_INSPECTION_FIXTURE = "training-no-power";
export const TRAINING_LIMITED_INSPECTION_FIXTURE = "training-limited";
export const TRAINING_INCOMPLETE_INSPECTION_FIXTURE = "training-incomplete";
export const TRAINING_STALE_INSPECTION_FIXTURE = "training-stale";

export const PLAN_INSPECTION_TURNS = Object.freeze([
  Object.freeze({
    turnId: "inspection-turn-week",
    completedAt: "1998-08-22T07:40:00.000Z",
    athleteText: "How does this week support the Gran Fondo?",
    coachText:
      "This week keeps one threshold session, one endurance ride, and recovery before the next build.",
  }),
  Object.freeze({
    turnId: "inspection-turn-recovery",
    completedAt: "1998-08-22T07:50:00.000Z",
    athleteText: "Keep Sunday easy if recovery slips.",
    coachText:
      "Yes. The current Plan keeps Sunday controlled and leaves the final choice visible in Plan.",
  }),
]);

export const PLAN_INSPECTION_ATTACHMENT_COMPOSER = Object.freeze({
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "codex-agent", model: "inspection-fixture", transport: "codex-agent" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "transport_incompatible",
      source: "transport_blocked",
      checkedAt: "1998-08-22T08:00:00.000Z",
    },
  },
  draft: null,
});

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

export function createPlanInspectionFixtureScript(
  athleteState: AthleteState = PLAN_QA_ATHLETE_STATE,
): DesktopFixtureScript {
  const plan = createPlanQaFixtureScript(PLAN_INSPECTION_SCENARIO_ID, athleteState);
  return {
    onRequest(value) {
      const request = value as { readonly method: string };
      if (request.method === "hasSession") return response({ hasSession: true });
      if (request.method === "getTranscriptPage") {
        return response({
          schemaVersion: 1,
          status: "page",
          turns: PLAN_INSPECTION_TURNS,
          nextCursor: null,
        });
      }
      if (request.method === "getChatAttachmentComposer") {
        return response(PLAN_INSPECTION_ATTACHMENT_COMPOSER);
      }
      if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
      if (request.method === "listPlanningRequests") {
        return response({ deliveries: [], planCreation: null });
      }
      return plan.onRequest(value);
    },
  };
}

export function inspectionAthleteState(inspectionFixture: string | undefined): AthleteState {
  if (inspectionFixture === undefined || inspectionFixture === PLAN_CURRENT_INSPECTION_FIXTURE) {
    return PLAN_QA_ATHLETE_STATE;
  }
  if (inspectionFixture === TRAINING_CURRENT_INSPECTION_FIXTURE) {
    return TRAINING_CURRENT_ATHLETE_STATE;
  }
  if (inspectionFixture === TRAINING_NO_POWER_INSPECTION_FIXTURE) {
    return TRAINING_NO_POWER_ATHLETE_STATE;
  }
  if (inspectionFixture === TRAINING_LIMITED_INSPECTION_FIXTURE) {
    return TRAINING_LIMITED_ATHLETE_STATE;
  }
  if (inspectionFixture === TRAINING_INCOMPLETE_INSPECTION_FIXTURE) {
    return TRAINING_INCOMPLETE_ATHLETE_STATE;
  }
  if (inspectionFixture === TRAINING_STALE_INSPECTION_FIXTURE) {
    return TRAINING_STALE_ATHLETE_STATE;
  }
  throw new TypeError("unknown desktop inspection fixture");
}

const token = "v".repeat(43);
let fixture: RunningDesktopFixture | undefined;

async function close(): Promise<void> {
  await fixture?.close();
  process.exit(0);
}

const directExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  const inspectionFixture =
    process.env.ENDURAGENT_DESKTOP_INSPECTION_FIXTURE ?? PLAN_CURRENT_INSPECTION_FIXTURE;
  const athleteState = inspectionAthleteState(inspectionFixture);
  fixture = await launchDesktopFixture({
    script: createPlanInspectionFixtureScript(athleteState),
    token,
    width: 1180,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
    hidden: false,
    routeChatAttachmentComposer: true,
  });
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  process.stdout.write(
    `DESKTOP_INSPECTION_READY ${inspectionFixture} ${PLAN_INSPECTION_SCENARIO_ID}\n`,
  );
}

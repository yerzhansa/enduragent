import { describe, expect, it, vi } from "vitest";
import { dropDayFrom, firstDropDay } from "../src/calendar/move";
import {
  createWorkoutCardController,
  WORKOUT_CARD_CLOSED,
  type WorkoutCardState,
} from "../src/calendar/workout-card-controller";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980112;
const TODAY = 19980113;

function harness() {
  const states: WorkoutCardState[] = [];
  const prefillComposer = vi.fn();
  const openChangeInChat = vi.fn();
  const controller = createWorkoutCardController({
    prefillComposer,
    openChangeInChat,
    publish: (state) => states.push(state),
  });
  return { controller, states, prefillComposer, openChangeInChat };
}

describe("the workout card controller", () => {
  it("opens one workout at a time and closes", () => {
    const test = harness();
    test.controller.open(PLAN_ID, workoutId(1));
    test.controller.open(PLAN_ID, workoutId(1));
    test.controller.open(PLAN_ID, workoutId(2));
    test.controller.close();
    test.controller.close();
    expect(test.states).toEqual([
      { kind: "open", planId: PLAN_ID, workoutId: workoutId(1) },
      { kind: "open", planId: PLAN_ID, workoutId: workoutId(2) },
      WORKOUT_CARD_CLOSED,
    ]);
  });

  it("asks Chat to prefill the question and opens the Plan change in Chat without sending", () => {
    const test = harness();
    test.controller.open(PLAN_ID, workoutId(1));
    test.controller.askCoach("Please change “Long endurance” on Wed 14 Jan:");
    expect(test.states.at(-1)).toEqual(WORKOUT_CARD_CLOSED);
    expect(test.prefillComposer).toHaveBeenCalledWith(
      "Please change “Long endurance” on Wed 14 Jan:",
    );
    expect(test.openChangeInChat).toHaveBeenCalledOnce();
  });

  it("asks nothing when no card is open", () => {
    const test = harness();
    test.controller.askCoach("Please change “Long endurance” on Wed 14 Jan:");
    expect(test.states).toEqual([]);
    expect(test.openChangeInChat).not.toHaveBeenCalled();
  });
});

describe("the day a workout can move to", () => {
  const read = calendarRead(
    TODAY,
    plan(
      MONDAY,
      [week(1, MONDAY), week(2, 19980119)],
      [
        workout(1, 19980114, { movable: true }),
        workout(2, 19980125, { movable: true }),
        workout(3, 19980112, { movable: false }),
      ],
    ),
  );
  const plans = read.plan?.workouts ?? [];
  const [middle, last, done] = plans;
  if (middle === undefined || last === undefined || done === undefined) {
    throw new TypeError("fixture workouts missing");
  }

  it("steps day by day inside the Plan, from today on, skipping the workout's own day", () => {
    expect(dropDayFrom(read, middle, 19980114, 1)).toBe(19980115);
    expect(dropDayFrom(read, middle, 19980115, -1)).toBe(TODAY);
    expect(dropDayFrom(read, middle, TODAY, -1)).toBeNull();
    expect(dropDayFrom(read, middle, 19980113, 1)).toBe(19980115);
    expect(dropDayFrom(read, middle, 19980125, 1)).toBeNull();
  });

  it("starts the next day, or the day before at the end of the Plan", () => {
    expect(firstDropDay(read, middle)).toBe(19980115);
    expect(firstDropDay(read, last)).toBe(19980124);
  });

  it("has no day for a workout that cannot move", () => {
    expect(firstDropDay(read, done)).toBeNull();
  });
});

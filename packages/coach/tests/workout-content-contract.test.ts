import type { PlanWorkoutContent } from "@enduragent/coach-contract";
import { workoutContent } from "@enduragent/sport-cycling";
import { describe, expectTypeOf, it } from "vitest";

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

describe("workout content contract", () => {
  it("builds content in the shape the Draft workout stores", () => {
    expectTypeOf(workoutContent).returns.toExtend<DeepReadonly<PlanWorkoutContent> | undefined>();
    expectTypeOf<PlanWorkoutContent | undefined>().toExtend<ReturnType<typeof workoutContent>>();
  });
});

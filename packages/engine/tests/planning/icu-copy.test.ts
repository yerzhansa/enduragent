import { describe, expect, it } from "vitest";
import {
  changeSetTargetApproval,
  changeSetTargetView,
  icuCopyAllowsMove,
  icuCopyChangeApproved,
  icuCopyDeleted,
  icuCopyKeep,
  icuCopyDrag,
  icuCopyOnRun,
  icuCopyPutBack,
  icuCopyWritten,
  ICU_COPY_NOT_SENT,
  type ChangeSetTargetView,
  type IcuCopy,
  type IcuCopyEffect,
  type IcuPlanSide,
  type IcuSighting,
} from "../../src/planning/icu-copy.js";
import { walk, type Step } from "./state-walk.js";

const EVENT_ID = 4_101;
const THURSDAY = 19980820;
const SATURDAY = 19980822;
const LATER_WEEK = 19980903;

type Content = "P" | "Q" | "E" | "F";
type IcuContent = "Pn" | "Qn" | "E" | "F";

type Icu =
  | { readonly kind: "gone" }
  | { readonly kind: "there"; readonly content: IcuContent; readonly day: number };

type PlanWorkout =
  | { readonly kind: "workout"; readonly content: Content; readonly day: number }
  | { readonly kind: "withdrawn" }
  | { readonly kind: "removed-by-you" };

type Proposal = { readonly kind: "change-to-q" } | { readonly kind: "withdraw" };

interface World {
  readonly dragOfKept: "none" | "pending";
  readonly laterWeek: "not-due" | "due";
  readonly icuUp: "up" | "down";
  readonly plan: PlanWorkout;
  readonly icu: Icu;
  readonly version: number;
  readonly copy: IcuCopy;
  readonly proposal:
    | { readonly kind: "none" }
    | { readonly kind: "open"; readonly change: Proposal; readonly view: ChangeSetTargetView };
  readonly agreed: Icu;
  readonly kept: Icu | { readonly kind: "none" };
  readonly approvedOverEdit: "yes" | "no";
  readonly lost: boolean;
  readonly lostKept: boolean;
  readonly needless: boolean;
}

function norm(content: Content): IcuContent {
  if (content === "P") return "Pn";
  if (content === "Q") return "Qn";
  return content;
}

function sameIcu(left: Icu | { readonly kind: "none" }, right: Icu): boolean {
  if (left.kind !== "there" || right.kind !== "there") return left.kind === right.kind;
  return left.content === right.content && left.day === right.day;
}

function planFingerprint(plan: PlanWorkout): string {
  return plan.kind === "workout" ? `plan:${plan.content}@${plan.day}` : `plan:${plan.kind}`;
}

function sighting(icu: Icu, version: number): IcuSighting {
  if (icu.kind === "gone") return { kind: "absent" };
  return {
    kind: "present",
    eventId: EVENT_ID,
    dateKey: icu.day,
    version: { fingerprint: `${icu.content}@${icu.day}`, updated: `v${version}` },
  };
}

function planSide(world: World): IcuPlanSide {
  if (world.plan.kind !== "workout") return { kind: "withdraw", reason: "not-in-plan" };
  if (world.plan.day === LATER_WEEK && world.laterWeek === "not-due")
    return { kind: "withdraw", reason: "not-due" };
  return { kind: "send", planFingerprint: planFingerprint(world.plan) };
}

function written(world: World, after: Icu, copy: IcuCopy, agreedTo: Icu): World {
  const keptHere = world.kept.kind !== "none" && sameIcu(world.kept, world.icu);
  const draggedKept = keptHere && world.dragOfKept === "pending";
  return {
    ...world,
    icu: after,
    version: world.version + 1,
    agreed: after,
    copy,
    lost: world.lost || !sameIcu(agreedTo, world.icu),
    lostKept: world.lostKept || (keptHere && !draggedKept && world.approvedOverEdit === "no"),
    needless: world.needless || sameIcu(after, world.icu),
    kept: draggedKept && after.kind === "there" ? after : { kind: "none" },
    approvedOverEdit: "no",
    dragOfKept: "none",
  };
}

function execute(
  world: World,
  copy: IcuCopy,
  effect: IcuCopyEffect,
  agreedTo: Icu = world.agreed,
): World {
  if (world.icuUp === "down" && effect.kind !== "none") return world;
  const current = sighting(world.icu, world.version);
  if (effect.kind === "delete") {
    if (current.kind !== "present" || current.version.fingerprint !== effect.expected.fingerprint) {
      return { ...world, copy: icuCopyOnRun(copy, planSide(world), current).copy };
    }
    return written(world, { kind: "gone" }, icuCopyDeleted(copy), agreedTo);
  }
  if (effect.kind !== "update" && effect.kind !== "create") return { ...world, copy };
  if (world.plan.kind !== "workout") return { ...world, copy };
  const stillAsSeen =
    effect.kind === "create"
      ? current.kind === "absent"
      : current.kind === "present" && current.version.fingerprint === effect.expected.fingerprint;
  if (!stillAsSeen) return { ...world, copy: icuCopyOnRun(copy, planSide(world), current).copy };
  const after: Icu = { kind: "there", content: norm(world.plan.content), day: world.plan.day };
  if (current.kind === "present" && sameIcu(world.icu, after)) {
    return {
      ...world,
      agreed: after,
      kept: { kind: "none" },
      approvedOverEdit: "no",
      copy: icuCopyWritten(copy, {
        eventId: EVENT_ID,
        dateKey: after.day,
        planFingerprint: planFingerprint(world.plan),
        readBack: current.version,
      }),
    };
  }
  const readBack = sighting(after, world.version + 1);
  if (readBack.kind !== "present") throw new Error("write lost");
  return written(
    world,
    after,
    icuCopyWritten(copy, {
      eventId: EVENT_ID,
      dateKey: after.day,
      planFingerprint: planFingerprint(world.plan),
      readBack: readBack.version,
    }),
    agreedTo,
  );
}

function appRuns(world: World): World {
  const decided = icuCopyOnRun(world.copy, planSide(world), sighting(world.icu, world.version));
  return execute(world, decided.copy, decided.effect);
}

function athleteChanges(world: World, to: Icu): World {
  return { ...world, icu: to, version: world.version + 1 };
}

function shownIcu(copy: IcuCopy): Icu | { readonly kind: "none" } {
  if (copy.kind !== "changed-in-icu") return { kind: "none" };
  if (copy.shown.kind === "absent") return { kind: "gone" };
  const content = copy.shown.version.fingerprint.split("@")[0];
  if (content === "Pn" || content === "Qn" || content === "E" || content === "F") {
    return { kind: "there", content, day: copy.shown.dateKey };
  }
  return { kind: "none" };
}

function planContent(content: IcuContent): Content {
  if (content === "Pn") return "P";
  if (content === "Qn") return "Q";
  return content;
}

function keep(world: World): World {
  const current = sighting(world.icu, world.version);
  const adopted: PlanWorkout =
    world.icu.kind === "gone"
      ? { kind: "removed-by-you" }
      : { kind: "workout", content: planContent(world.icu.content), day: world.icu.day };
  const result = icuCopyKeep(world.copy, current, planSide(world), planFingerprint(adopted));
  if (result.kind !== "done") return { ...world, copy: result.copy };
  if (world.plan.kind !== "workout") return { ...world, copy: result.copy, agreed: world.icu };
  return { ...world, copy: result.copy, plan: adopted, agreed: world.icu, kept: world.icu };
}

function putBack(world: World): World {
  const onCard = shownIcu(world.copy);
  const result = icuCopyPutBack(world.copy, sighting(world.icu, world.version), planSide(world));
  if (result.kind === "done" && result.effect.kind === "none") {
    return { ...world, copy: result.copy, agreed: world.icu };
  }
  if (result.kind !== "done" || onCard.kind === "none") return { ...world, copy: result.copy };
  return execute(world, result.copy, result.effect, onCard);
}

function coachProposes(world: World, change: Proposal): World {
  return {
    ...world,
    proposal: {
      kind: "open",
      change,
      view: changeSetTargetView(world.copy, planFingerprint(world.plan)),
    },
  };
}

function approve(world: World): World {
  if (world.proposal.kind !== "open") return world;
  const approval = changeSetTargetApproval(
    world.proposal.view,
    world.copy,
    planFingerprint(world.plan),
  );
  if (approval.kind === "refresh") {
    return { ...world, proposal: { ...world.proposal, view: approval.view } };
  }
  const plan: PlanWorkout =
    world.proposal.change.kind === "withdraw"
      ? { kind: "withdrawn" }
      : {
          kind: "workout",
          content: "Q",
          day: world.plan.kind === "workout" ? world.plan.day : THURSDAY,
        };
  return {
    ...world,
    plan,
    copy: icuCopyChangeApproved(world.copy, approval.mark),
    proposal: { kind: "none" },
    approvedOverEdit: approval.mark === "replaces-your-edit" ? "yes" : world.approvedOverEdit,
  };
}

function athleteOptions(world: World): readonly Icu[] {
  if (world.icu.kind === "gone") return [];
  const { day } = world.icu;
  const options: Icu[] = [
    { kind: "there", content: "E", day },
    { kind: "there", content: "F", day },
    { kind: "there", content: world.icu.content, day: day === THURSDAY ? SATURDAY : THURSDAY },
    { kind: "gone" },
  ];
  if (world.agreed.kind === "there") options.push(world.agreed);
  return options.filter((option) => !sameIcu(option, world.icu));
}

function dragTargets(world: World): readonly number[] {
  if (world.plan.kind !== "workout") return [];
  const from = world.plan.day;
  return [THURSDAY, SATURDAY, LATER_WEEK].filter((day) => day !== from);
}

function athleteDrags(world: World, day: number): World {
  if (world.plan.kind !== "workout") return world;
  const plan: PlanWorkout = { ...world.plan, day };
  const moved = icuCopyDrag(world.copy, planFingerprint(plan));
  if (moved === null) return world;
  const ownedEdit =
    (world.copy.kind === "on-icu" || world.copy.kind === "moving-by-you") &&
    world.copy.baseline.owner === "athlete-edit";
  return { ...world, plan, copy: moved, dragOfKept: ownedEdit ? "pending" : world.dragOfKept };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [["the app runs", appRuns(world)]];
  for (const to of athleteOptions(world)) {
    steps.push([
      `the athlete changes it in intervals.icu to ${JSON.stringify(to)}`,
      athleteChanges(world, to),
    ]);
  }
  if (icuCopyAllowsMove(world.copy)) {
    for (const day of dragTargets(world)) {
      steps.push([`the athlete drags it in the app to ${day}`, athleteDrags(world, day)]);
    }
  }
  if (world.laterWeek === "not-due") {
    steps.push(["the later week becomes due", { ...world, laterWeek: "due" }]);
  }
  steps.push([
    world.icuUp === "up" ? "intervals.icu stops answering" : "intervals.icu answers again",
    { ...world, icuUp: world.icuUp === "up" ? "down" : "up" },
  ]);
  if (world.copy.kind === "changed-in-icu") {
    steps.push(["the athlete presses Keep", keep(world)]);
    steps.push(["the athlete presses Put back", putBack(world)]);
  }
  if (world.proposal.kind === "none" && world.plan.kind !== "withdrawn") {
    if (world.plan.kind !== "workout" || world.plan.content !== "Q") {
      steps.push(["the coach proposes a change", coachProposes(world, { kind: "change-to-q" })]);
    }
    steps.push(["the coach proposes removing it", coachProposes(world, { kind: "withdraw" })]);
  }
  if (world.proposal.kind === "open") {
    steps.push(["the athlete approves the change", approve(world)]);
    if (world.proposal.view.mark === "replaces-your-edit") {
      steps.push([
        "the athlete approves, keeping their edit",
        { ...world, proposal: { kind: "none" } },
      ]);
    }
  }
  return steps;
}

function start(): World {
  const world: World = {
    dragOfKept: "none",
    laterWeek: "not-due",
    icuUp: "up",
    plan: { kind: "workout", content: "P", day: THURSDAY },
    icu: { kind: "gone" },
    version: 0,
    copy: ICU_COPY_NOT_SENT,
    proposal: { kind: "none" },
    agreed: { kind: "gone" },
    kept: { kind: "none" },
    approvedOverEdit: "no",
    lost: false,
    lostKept: false,
    needless: false,
  };
  return appRuns(world);
}

const RULES = {
  NeverUndoneByItself: (world: World) => !world.lost,
  KeptEditReplacedOnlyWhenFlagged: (world: World) => !world.lostKept,
  CardOnlyForRealChanges: (world: World) => {
    const shown = shownIcu(world.copy);
    return (
      world.copy.kind !== "changed-in-icu" ||
      (shown.kind !== "none" && !sameIcu(shown, world.agreed))
    );
  },
  NoRewriteOfSameWorkout: (world: World) => !world.needless,
  APlanWorkoutIsNeverAbandoned: (world: World) =>
    world.copy.kind !== "kept-as-yours" || world.plan.kind === "withdrawn",
};

function copyKey(copy: IcuCopy): unknown {
  if (copy.kind === "on-icu") {
    return {
      ...copy,
      baseline: { ...copy.baseline, readBack: copy.baseline.readBack.fingerprint },
    };
  }
  if (copy.kind === "changed-in-icu") {
    return {
      ...copy,
      baseline: { ...copy.baseline, readBack: copy.baseline.readBack.fingerprint },
      shown:
        copy.shown.kind === "absent"
          ? "absent"
          : [copy.shown.dateKey, copy.shown.version.fingerprint],
    };
  }
  return copy;
}

function key(world: World): string {
  return JSON.stringify({ ...world, version: undefined, copy: copyKey(world.copy) });
}

const P_THURSDAY: Icu = { kind: "there", content: "Pn", day: THURSDAY };

describe("a Plan Workout's copy on intervals.icu", () => {
  it("keeps every rule on every path of up to eight steps", () => {
    const result = walk({ initial: [start()], next, key, rules: RULES, maxDepth: 8 });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(1_000);
  });

  it("does not send the Plan's version over an edit made in intervals.icu", () => {
    const edited = athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY });
    const decided = icuCopyOnRun(
      edited.copy,
      planSide(edited),
      sighting(edited.icu, edited.version),
    );
    expect(decided.effect).toEqual({ kind: "none" });
    expect(decided.copy.kind).toBe("changed-in-icu");
    expect(appRuns(edited).lost).toBe(false);
  });

  it("does not open the card when intervals.icu only stored our write in its own format", () => {
    const world = start();
    expect(world.icu).toEqual(P_THURSDAY);
    const again = appRuns(world);
    expect(again.copy.kind).toBe("on-icu");
    expect(
      icuCopyOnRun(again.copy, planSide(again), sighting(again.icu, again.version + 7)).copy.kind,
    ).toBe("on-icu");
  });

  it("refreshes the card instead of putting back over a newer edit", () => {
    const card = appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY }));
    expect(card.copy.kind).toBe("changed-in-icu");
    const pressed = putBack(athleteChanges(card, { kind: "there", content: "F", day: THURSDAY }));
    expect(pressed.icu).toEqual({ kind: "there", content: "F", day: THURSDAY });
    expect(pressed.lost).toBe(false);
    expect(pressed.copy).toMatchObject({
      kind: "changed-in-icu",
      shown: { version: { fingerprint: "F@19980820" } },
    });
  });

  it("marks a coach change shown before a Keep as replacing the athlete's edit", () => {
    const card = appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY }));
    const proposed = coachProposes(card, { kind: "change-to-q" });
    expect(proposed.proposal).toMatchObject({ view: { mark: "plain" } });
    const kept = keep(proposed);
    expect(kept.copy).toMatchObject({ kind: "on-icu", baseline: { owner: "athlete-edit" } });
    const refreshed = approve(kept);
    expect(refreshed.plan).toEqual({ kind: "workout", content: "E", day: THURSDAY });
    expect(refreshed.proposal).toMatchObject({ view: { mark: "replaces-your-edit" } });
    const approved = appRuns(approve(refreshed));
    expect(approved.icu).toEqual({ kind: "there", content: "Qn", day: THURSDAY });
    expect(approved.lostKept).toBe(false);
  });

  it("never rewrites a kept edit for an unmarked Plan change", () => {
    const kept = keep(
      appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY })),
    );
    const changedUnmarked: World = {
      ...kept,
      plan: { kind: "workout", content: "Q", day: THURSDAY },
    };
    const decided = icuCopyOnRun(
      changedUnmarked.copy,
      planSide(changedUnmarked),
      sighting(kept.icu, kept.version),
    );
    expect(decided.effect).toEqual({ kind: "none" });
  });

  it("sees a move made in intervals.icu and keeps it through a later coach change", () => {
    const moved = appRuns(athleteChanges(start(), { kind: "there", content: "Pn", day: SATURDAY }));
    expect(moved.copy).toMatchObject({ kind: "changed-in-icu", shown: { dateKey: SATURDAY } });
    const kept = keep(moved);
    expect(kept.plan).toMatchObject({ day: SATURDAY });
    const changed = appRuns(approve(approve(coachProposes(kept, { kind: "change-to-q" }))));
    expect(changed.icu).toEqual({ kind: "there", content: "Qn", day: SATURDAY });
    expect(changed.lost).toBe(false);
  });

  it("closes the card when the athlete changes the workout back", () => {
    const card = appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY }));
    expect(appRuns(athleteChanges(card, P_THURSDAY)).copy.kind).toBe("on-icu");
  });

  it("closes the card when the athlete deleted a workout the coach then removed", () => {
    const card = appRuns(athleteChanges(start(), { kind: "gone" }));
    const withdrawn: World = { ...card, plan: { kind: "withdrawn" } };
    expect(appRuns(withdrawn).copy).toEqual(ICU_COPY_NOT_SENT);
  });

  it("deletes an edited workout on Put back once the coach removed it from the Plan", () => {
    const card = appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY }));
    const withdrawn: World = { ...card, plan: { kind: "withdrawn" } };
    const result = icuCopyPutBack(
      withdrawn.copy,
      sighting(withdrawn.icu, withdrawn.version),
      planSide(withdrawn),
    );
    expect(result).toMatchObject({
      kind: "done",
      effect: { kind: "delete", expected: { fingerprint: "E@19980820" } },
    });
    expect(
      icuCopyKeep(
        withdrawn.copy,
        sighting(withdrawn.icu, withdrawn.version),
        planSide(withdrawn),
        "x",
      ),
    ).toMatchObject({
      kind: "done",
      copy: { kind: "kept-as-yours", eventId: EVENT_ID },
    });
  });

  it("refuses a drag while the card is open", () => {
    const card = appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY }));
    expect(icuCopyAllowsMove(card.copy)).toBe(false);
    expect(icuCopyAllowsMove(keep(card).copy)).toBe(true);
  });

  it("keeps a deletion made in intervals.icu as Removed by you", () => {
    const kept = keep(appRuns(athleteChanges(start(), { kind: "gone" })));
    expect(kept.copy.kind).toBe("removed-by-you");
    expect(kept.plan).toEqual({ kind: "removed-by-you" });
    expect(appRuns(kept).icu).toEqual({ kind: "gone" });
    expect(changeSetTargetView(kept.copy, "plan:Q").mark).toBe("replaces-your-edit");
    expect(icuCopyChangeApproved(kept.copy, "replaces-your-edit")).toEqual(ICU_COPY_NOT_SENT);
  });

  it("puts a deleted workout back with a new event", () => {
    const restored = putBack(appRuns(athleteChanges(start(), { kind: "gone" })));
    expect(restored.icu).toEqual(P_THURSDAY);
    expect(restored.copy.kind).toBe("on-icu");
  });

  it("takes a fresh updated time without opening the card", () => {
    const world = start();
    const decided = icuCopyOnRun(world.copy, planSide(world), sighting(P_THURSDAY, 40));
    expect(decided.effect).toEqual({ kind: "none" });
    expect(decided.copy).toMatchObject({
      kind: "on-icu",
      baseline: { readBack: { updated: "v40" } },
    });
  });

  it("sends one update for an event found without a receipt, and leaves an unknown one alone", () => {
    const found = sighting({ kind: "there", content: "Pn", day: THURSDAY }, 3);
    expect(
      icuCopyOnRun(ICU_COPY_NOT_SENT, { kind: "send", planFingerprint: "plan:P" }, found),
    ).toMatchObject({
      copy: { kind: "on-icu", baseline: { planFingerprint: "unknown" } },
      effect: { kind: "update", expected: { fingerprint: "Pn@19980820" } },
    });
    expect(
      icuCopyOnRun(ICU_COPY_NOT_SENT, { kind: "withdraw", reason: "not-in-plan" }, found),
    ).toEqual({
      copy: ICU_COPY_NOT_SENT,
      effect: { kind: "none" },
    });
  });

  it("sends a drag of a kept edit to intervals.icu and keeps it the athlete's", () => {
    const kept = keep(
      appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY })),
    );
    expect(kept.copy).toMatchObject({ kind: "on-icu", baseline: { owner: "athlete-edit" } });
    const dragged = athleteDrags(kept, SATURDAY);
    expect(dragged.copy.kind).toBe("moving-by-you");
    const failed = appRuns({ ...dragged, icuUp: "down" });
    expect(failed.copy.kind).toBe("moving-by-you");
    const sent = appRuns({ ...failed, icuUp: "up" });
    expect(sent.icu).toEqual({ kind: "there", content: "E", day: SATURDAY });
    expect(sent.copy).toMatchObject({ kind: "on-icu", baseline: { owner: "athlete-edit" } });
    expect(coachProposes(sent, { kind: "change-to-q" }).proposal).toMatchObject({
      view: { mark: "replaces-your-edit" },
    });
  });

  it("takes a dragged workout off intervals.icu until its new week is due", () => {
    const kept = keep(
      appRuns(athleteChanges(start(), { kind: "there", content: "E", day: THURSDAY })),
    );
    const away = appRuns(athleteDrags(kept, LATER_WEEK));
    expect(away.icu).toEqual({ kind: "gone" });
    expect(away.copy).toEqual(ICU_COPY_NOT_SENT);
    const due = appRuns({ ...away, laterWeek: "due" });
    expect(due.icu).toEqual({ kind: "there", content: "E", day: LATER_WEEK });
  });

  it("shows the card when intervals.icu changed after a drag", () => {
    const dragged = athleteDrags(start(), SATURDAY);
    const changed = appRuns(
      athleteChanges(dragged, { kind: "there", content: "E", day: THURSDAY }),
    );
    expect(changed.copy.kind).toBe("changed-in-icu");
    expect(icuCopyAllowsMove(changed.copy)).toBe(false);
  });
});

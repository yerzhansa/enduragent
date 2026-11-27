import { describe, expect, it } from "vitest";
import {
  changeSetTargetApproval,
  changeSetTargetView,
  icuCopyAllowsMove,
  icuCopyKeep,
  icuCopyOnRun,
  icuCopyPutBack,
  icuCopyWritten,
  ICU_COPY_NOT_SENT,
  type ChangeSetTargetView,
  type IcuCopy,
  type IcuCopyEffect,
  type IcuSighting,
} from "../../src/planning/icu-copy.js";
import { walk, type Step } from "./state-walk.js";

const EVENT_ID = 4_101;
const DAY = 19980822;

type Content = "P" | "Q" | "E" | "F";
type IcuContent = "Pn" | "Qn" | "E" | "F" | "gone";

interface World {
  readonly plan: Content | "removed";
  readonly icu: IcuContent;
  readonly version: number;
  readonly copy: IcuCopy;
  readonly proposal:
    | { readonly kind: "none" }
    | { readonly kind: "open"; readonly view: ChangeSetTargetView };
  readonly agreed: IcuContent;
  readonly kept: IcuContent | "none";
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

function planFingerprint(content: Content): string {
  return `plan:${content}`;
}

function sighting(icu: IcuContent, version: number): IcuSighting {
  if (icu === "gone") return { kind: "absent" };
  return {
    kind: "present",
    eventId: EVENT_ID,
    dateKey: DAY,
    version: { fingerprint: icu, updated: `v${version}` },
  };
}

function planSide(world: World) {
  return world.plan === "removed"
    ? ({ kind: "withdraw" } as const)
    : ({ kind: "send", planFingerprint: planFingerprint(world.plan) } as const);
}

function execute(
  world: World,
  copy: IcuCopy,
  effect: IcuCopyEffect,
  agreedTo: IcuContent = world.agreed,
): World {
  if (effect.kind !== "update" && effect.kind !== "create") return { ...world, copy };
  if (world.plan === "removed") return { ...world, copy };
  const current = sighting(world.icu, world.version);
  const stillAsSeen =
    effect.kind === "create"
      ? current.kind === "absent"
      : current.kind === "present" && current.version.fingerprint === effect.expected.fingerprint;
  if (!stillAsSeen) return { ...world, copy: icuCopyOnRun(copy, planSide(world), current).copy };
  const written = norm(world.plan);
  const version = world.version + 1;
  const readBack = sighting(written, version);
  if (readBack.kind !== "present") throw new Error("write lost");
  return {
    ...world,
    icu: written,
    version,
    agreed: written,
    copy: icuCopyWritten(copy, {
      eventId: EVENT_ID,
      dateKey: DAY,
      planFingerprint: planFingerprint(world.plan),
      readBack: readBack.version,
    }),
    lost: world.lost || world.icu !== agreedTo,
    lostKept:
      world.lostKept ||
      (world.kept !== "none" && world.icu === world.kept && world.approvedOverEdit === "no"),
    needless: world.needless || world.icu === written,
    kept: "none",
    approvedOverEdit: "no",
  };
}

function appRuns(world: World): World {
  const decided = icuCopyOnRun(world.copy, planSide(world), sighting(world.icu, world.version));
  return execute(world, decided.copy, decided.effect);
}

function athleteChanges(world: World, to: IcuContent): World {
  return { ...world, icu: to, version: world.version + 1 };
}

function keep(world: World): World {
  const current = sighting(world.icu, world.version);
  const adopted: Content | "removed" =
    current.kind === "absent" ? "removed" : current.version.fingerprint === "F" ? "F" : "E";
  const result = icuCopyKeep(
    world.copy,
    current,
    planFingerprint(adopted === "removed" ? "E" : adopted),
  );
  if (result.kind !== "done") return { ...world, copy: result.copy };
  return {
    ...world,
    copy: result.copy,
    plan: adopted,
    agreed: world.icu,
    kept: world.icu,
  };
}

function shownContent(copy: IcuCopy): IcuContent | "none" {
  if (copy.kind !== "changed-in-icu") return "none";
  if (copy.shown.kind === "absent") return "gone";
  const shown = copy.shown.version.fingerprint;
  if (shown === "Pn" || shown === "Qn" || shown === "E" || shown === "F") return shown;
  return "none";
}

function putBack(world: World): World {
  const onCard = shownContent(world.copy);
  const result = icuCopyPutBack(world.copy, sighting(world.icu, world.version));
  if (result.kind !== "done" || onCard === "none") return { ...world, copy: result.copy };
  return execute(world, result.copy, result.effect, onCard);
}

function coachProposes(world: World): World {
  if (world.plan === "removed") return world;
  return {
    ...world,
    proposal: { kind: "open", view: changeSetTargetView(world.copy, planFingerprint(world.plan)) },
  };
}

function approve(world: World): World {
  if (world.proposal.kind !== "open" || world.plan === "removed") return world;
  const approval = changeSetTargetApproval(
    world.proposal.view,
    world.copy,
    planFingerprint(world.plan),
  );
  if (approval.kind === "refresh") {
    return { ...world, proposal: { kind: "open", view: approval.view } };
  }
  return {
    ...world,
    plan: "Q",
    proposal: { kind: "none" },
    approvedOverEdit: approval.mark === "replaces-your-edit" ? "yes" : "no",
  };
}

function approveKeepMine(world: World): World {
  return { ...world, proposal: { kind: "none" } };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [["the app runs", appRuns(world)]];
  for (const to of ["E", "F", "gone", world.agreed] as const) {
    if (to !== world.icu)
      steps.push([`the athlete changes it in intervals.icu to ${to}`, athleteChanges(world, to)]);
  }
  if (world.copy.kind === "changed-in-icu") {
    steps.push(["the athlete presses Keep", keep(world)]);
    steps.push(["the athlete presses Put back", putBack(world)]);
  }
  if (world.proposal.kind === "none" && world.plan !== "Q" && world.plan !== "removed") {
    steps.push(["the coach proposes a change", coachProposes(world)]);
  }
  if (world.proposal.kind === "open") {
    steps.push(["the athlete approves the change", approve(world)]);
    if (world.proposal.view.mark === "replaces-your-edit") {
      steps.push(["the athlete approves, keeping their edit", approveKeepMine(world)]);
    }
  }
  return steps;
}

function written(content: Content): World {
  const start: World = {
    plan: content,
    icu: "gone",
    version: 0,
    copy: ICU_COPY_NOT_SENT,
    proposal: { kind: "none" },
    agreed: "gone",
    kept: "none",
    approvedOverEdit: "no",
    lost: false,
    lostKept: false,
    needless: false,
  };
  return appRuns(start);
}

const RULES = {
  NeverUndoneByItself: (world: World) => !world.lost,
  KeptEditReplacedOnlyWhenFlagged: (world: World) => !world.lostKept,
  CardOnlyForRealChanges: (world: World) =>
    world.copy.kind !== "changed-in-icu" ||
    (world.copy.shown.kind === "absent" ? "gone" : world.copy.shown.version.fingerprint) !==
      world.agreed,
  NoRewriteOfSameWorkout: (world: World) => !world.needless,
};

function key(world: World): string {
  return JSON.stringify({ ...world, version: undefined, copy: copyKey(world.copy) });
}

function copyKey(copy: IcuCopy): unknown {
  if (copy.kind === "on-icu")
    return {
      ...copy,
      baseline: { ...copy.baseline, readBack: copy.baseline.readBack.fingerprint },
    };
  if (copy.kind === "changed-in-icu") {
    return {
      kind: copy.kind,
      owner: copy.baseline.owner,
      base: copy.baseline.readBack.fingerprint,
      plan: copy.baseline.planFingerprint,
      shown: copy.shown.kind === "absent" ? "absent" : copy.shown.version.fingerprint,
    };
  }
  return copy;
}

describe("a Plan Workout's copy on intervals.icu", () => {
  it("keeps every rule on every path of up to nine steps", () => {
    const result = walk({
      initial: [written("P")],
      next,
      key,
      rules: RULES,
      maxDepth: 9,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(100);
  });

  it("does not send the Plan's version over an edit made in intervals.icu", () => {
    const edited = athleteChanges(written("P"), "E");
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
    const world = written("P");
    expect(world.icu).toBe("Pn");
    const again = appRuns(world);
    expect(again.copy.kind).toBe("on-icu");
    expect(
      icuCopyOnRun(again.copy, planSide(again), sighting(again.icu, again.version + 7)).copy.kind,
    ).toBe("on-icu");
  });

  it("refreshes the card instead of putting back over a newer edit", () => {
    const card = appRuns(athleteChanges(written("P"), "E"));
    expect(card.copy.kind).toBe("changed-in-icu");
    const editedAgain = athleteChanges(card, "F");
    const pressed = putBack(editedAgain);
    expect(pressed.icu).toBe("F");
    expect(pressed.lost).toBe(false);
    expect(pressed.copy).toMatchObject({
      kind: "changed-in-icu",
      shown: { kind: "present", version: { fingerprint: "F" } },
    });
  });

  it("marks a coach change shown before a Keep as replacing the athlete's edit", () => {
    const card = appRuns(athleteChanges(written("P"), "E"));
    const proposed = coachProposes(card);
    expect(proposed.proposal).toMatchObject({ view: { mark: "plain" } });
    const kept = keep(proposed);
    expect(kept.copy).toMatchObject({ kind: "on-icu", baseline: { owner: "athlete-edit" } });
    const refreshed = approve(kept);
    expect(refreshed.plan).toBe("E");
    expect(refreshed.proposal).toMatchObject({ view: { mark: "replaces-your-edit" } });
    const approved = appRuns(approve(refreshed));
    expect(approved.icu).toBe("Qn");
    expect(approved.lostKept).toBe(false);
  });

  it("closes the card when the athlete changes the workout back", () => {
    const card = appRuns(athleteChanges(written("P"), "E"));
    const back = appRuns(athleteChanges(card, "Pn"));
    expect(back.copy.kind).toBe("on-icu");
  });

  it("refuses a drag while the card is open", () => {
    const card = appRuns(athleteChanges(written("P"), "E"));
    expect(icuCopyAllowsMove(card.copy)).toBe(false);
    expect(icuCopyAllowsMove(keep(card).copy)).toBe(true);
  });

  it("keeps a deletion made in intervals.icu as Removed by you", () => {
    const card = appRuns(athleteChanges(written("P"), "gone"));
    const kept = keep(card);
    expect(kept.copy.kind).toBe("removed-by-you");
    expect(kept.plan).toBe("removed");
    expect(appRuns(kept).icu).toBe("gone");
  });

  it("puts a deleted workout back with a new event", () => {
    const card = appRuns(athleteChanges(written("P"), "gone"));
    const restored = putBack(card);
    expect(restored.icu).toBe("Pn");
    expect(restored.copy.kind).toBe("on-icu");
  });

  it("takes a fresh updated time without opening the card", () => {
    const world = written("P");
    const decided = icuCopyOnRun(world.copy, planSide(world), sighting("Pn", 40));
    expect(decided.effect).toEqual({ kind: "none" });
    expect(decided.copy).toMatchObject({
      kind: "on-icu",
      baseline: { readBack: { updated: "v40" } },
    });
  });
});

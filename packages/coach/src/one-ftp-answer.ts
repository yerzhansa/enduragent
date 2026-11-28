import type {
  PlanCalendarFtpAnswer,
  PlanCalendarFtpExpected,
  PlanCalendarFtpOutcome,
  PlanCalendarFtpRead,
} from "@enduragent/coach-contract";
import { ftpProposalStep, writeIfUnchanged, type FtpProposal } from "@enduragent/engine/calendar";
import type { IcuRideSettings } from "./one-ftp-icu.js";
import { check, ftpOwner, readModel, serially, settled, type OneFtpDeps } from "./one-ftp.js";
import {
  readFtpRecord,
  recordAcceptedFtp,
  saveFtpRecord,
  type FtpProposalRecord,
} from "./one-ftp-store.js";

type Confirming = Extract<FtpProposal, { kind: "confirming" }>;

async function liveRide(deps: OneFtpDeps): Promise<IcuRideSettings | null> {
  try {
    return await deps.icu.readRide();
  } catch {
    return null;
  }
}

async function save(deps: OneFtpDeps, record: FtpProposalRecord): Promise<void> {
  await saveFtpRecord(deps.store, record, deps.now());
}

async function written(
  deps: OneFtpDeps,
  record: FtpProposalRecord,
  writing: FtpProposal,
  proposal: Confirming,
  settings: IcuRideSettings,
): Promise<PlanCalendarFtpOutcome> {
  const recordAthlete = settings.record.athlete_id;
  const athleteId =
    typeof recordAthlete === "string" && recordAthlete.length > 0
      ? recordAthlete
      : await ftpOwner(deps.store, deps.athleteId());
  if (athleteId !== null) {
    await recordAcceptedFtp(deps.store, {
      id: deps.newId(),
      athleteId,
      watts: proposal.watts,
      previousWatts: proposal.icuWattsShown,
      basis: proposal.basis.kind,
      icuUpdatedMs: settings.updatedMs,
      writtenAtMs: deps.now(),
    });
  }
  const finished = ftpProposalStep(writing, { type: "write-finished" });
  await save(deps, settled(record, finished.proposal, deps.todayDateKey()));
  return "written";
}

async function confirm(
  deps: OneFtpDeps,
  record: FtpProposalRecord,
  proposal: Confirming,
): Promise<PlanCalendarFtpOutcome> {
  const today = deps.todayDateKey();
  const live = await liveRide(deps);
  if (live === null) return "unavailable";
  if (live.ftpWatts === proposal.watts) {
    const held = ftpProposalStep(proposal, {
      type: "icu-holds-proposal",
      icuWattsNow: live.ftpWatts,
    });
    await save(deps, settled(record, held.proposal, today));
    return "none";
  }
  const confirmed = ftpProposalStep(proposal, {
    type: "athlete-confirms",
    icuWattsNow: live.ftpWatts,
  });
  if (confirmed.effect.kind !== "write-ftp") {
    await save(
      deps,
      settled(record, confirmed.proposal, today, { icuChangedAtMs: live.updatedMs }),
    );
    return "changed";
  }
  const target = confirmed.effect.watts;
  const expected = confirmed.effect.expectedIcuWatts;
  const result = await writeIfUnchanged<IcuRideSettings, IcuRideSettings>({
    read: () => deps.icu.readRide(),
    alreadyWritten: (current) => current.ftpWatts === target,
    stillAsSeen: (current) => current.ftpWatts === expected,
    write: (current) => deps.icu.writeRideFtp({ settings: current, watts: target }),
  });
  switch (result.kind) {
    case "written":
      return written(deps, record, confirmed.proposal, proposal, result.written);
    case "unchanged": {
      const finished = ftpProposalStep(confirmed.proposal, { type: "write-finished" });
      await save(deps, settled(record, finished.proposal, today));
      return "none";
    }
    case "changed": {
      const refused = ftpProposalStep(confirmed.proposal, {
        type: "write-refused",
        icuWattsNow: result.current.ftpWatts,
      });
      await save(
        deps,
        settled(record, refused.proposal, today, { icuChangedAtMs: result.current.updatedMs }),
      );
      return "changed";
    }
    case "write-failed": {
      const reread = await liveRide(deps);
      if (reread !== null && reread.ftpWatts === target) {
        return written(deps, record, confirmed.proposal, proposal, reread);
      }
      break;
    }
    case "read-failed":
      break;
  }
  const failed = ftpProposalStep(confirmed.proposal, { type: "write-failed" });
  await save(deps, settled(record, failed.proposal, today));
  return "unavailable";
}

async function answer(
  deps: OneFtpDeps,
  record: FtpProposalRecord,
  answerKind: PlanCalendarFtpAnswer,
): Promise<PlanCalendarFtpOutcome> {
  const proposal = record.proposal;
  const today = deps.todayDateKey();
  if (answerKind === "keep" && (proposal.kind === "shown" || proposal.kind === "confirming")) {
    const shown =
      proposal.kind === "confirming"
        ? ftpProposalStep(proposal, { type: "athlete-cancels" }).proposal
        : proposal;
    const kept = ftpProposalStep(shown, { type: "athlete-keeps", todayDateKey: today });
    await save(deps, settled(record, kept.proposal, today));
    return "none";
  }
  if (answerKind === "use" && proposal.kind === "shown") {
    const live = await liveRide(deps);
    if (live === null) return "unavailable";
    const used = ftpProposalStep(proposal, { type: "athlete-uses", icuWatts: live.ftpWatts });
    if (used.proposal.kind === "confirming" && live.ftpWatts === proposal.watts) {
      const held = ftpProposalStep(used.proposal, {
        type: "icu-holds-proposal",
        icuWattsNow: live.ftpWatts,
      });
      await save(deps, settled(record, held.proposal, today));
      return "none";
    }
    await save(
      deps,
      settled(record, used.proposal, today, { usedIcuWatts: live.ftpWatts, icuChangedAtMs: null }),
    );
    return "none";
  }
  if (answerKind === "cancel" && proposal.kind === "confirming") {
    const cancelled = ftpProposalStep(proposal, { type: "athlete-cancels" });
    await save(deps, settled(record, cancelled.proposal, today));
    return "none";
  }
  if (answerKind === "confirm" && proposal.kind === "confirming") {
    return confirm(deps, record, proposal);
  }
  return "refused";
}

export async function answerFtp(
  deps: OneFtpDeps,
  request: { readonly answer: PlanCalendarFtpAnswer; readonly expected: PlanCalendarFtpExpected },
): Promise<PlanCalendarFtpRead> {
  return serially(deps.store, async () => {
    const record = await readFtpRecord(deps.store, await ftpOwner(deps.store, deps.athleteId()));
    const proposal = record.proposal;
    const matches =
      (proposal.kind === "shown" || proposal.kind === "confirming") &&
      proposal.kind === request.expected.kind &&
      proposal.watts === request.expected.watts;
    const outcome = matches ? await answer(deps, record, request.answer) : "refused";
    await check(deps);
    return readModel(deps, outcome);
  });
}

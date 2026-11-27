// Reader's words for /statechart. One region per actor the athlete can see.

const replyLabel = {
  absent: "No reply",
  admitting: "Reply waiting to start",
  streaming: "Reply streaming",
  stopping: "Reply stopping",
  stopped: "Reply ended",
  finished: "Reply ended",
};

const stopLabel = {
  absent: "Stop not pressed",
  admitting: "Stop waiting",
  reached: "Stop reached the reply",
  missed: "Stop found nothing to stop",
  "timed-out": "Stop gave up",
};

const changeLabel = (v) => {
  switch (v.change) {
    case "absent":
      return "No coach change";
    case "queued":
    case "building":
    case "committing":
      return "Coach change building";
    case "draining":
      if (v.deadlineFired) return "Change past its deadline, still waiting";
      return v.aborted ? "Change cancelled, still waiting" : "Change waiting for the reply";
    case "applied":
      return "Coach change applied";
    case "refused":
      return "Coach change refused";
    case "failed":
      return "Coach change dropped";
    default:
      return v.change;
  }
};

const readsLabel = (v) => {
  if (v.cfgRead === "timed-out" || v.pageRead === "timed-out") return "A read gave up";
  if (v.cfgRead === "queued" || v.pageRead === "admitting") return "A read is waiting";
  return "Reads answered";
};

const windowLabel = (v) => {
  if (v.screen === "setup-gate") return "Setup screen";
  const leaked = [v.catalogSession, v.engineConfig, v.profilesFile].includes("new");
  if (v.desktop === "failed" || v.desktop === "refused")
    return leaked ? "Told it failed, new model half applied" : "Told it failed";
  if (v.desktop === "applied") return "Told it applied";
  return v.desktop === "waiting" ? "Waiting for the coach" : "Idle";
};

export const title = "A coach change while the coach replies";

export const state = (v) => ({
  Reply: replyLabel[v.reply],
  Stop: stopLabel[v.stop],
  Change: changeLabel(v),
  Reads: readsLabel(v),
  Window: windowLabel(v),
});

const kindWords = {
  "model-change": "the athlete picks another model in Settings",
  "key-delete": "the athlete deletes the AI key in use",
  "chatgpt-activation": "the athlete activates ChatGPT",
};

export const step = (action, from, to) => {
  switch (action) {
    case "ReplyArrives":
      return "the athlete sends a message";
    case "ReplyAdmitted":
      return "the coach starts the reply";
    case "ReplyFinishes":
      return "the reply ends on its own";
    case "ReplyStops":
      return "the reply stops";
    case "StopArrives":
      return "the athlete presses Stop";
    case "StopAdmitted":
      return to.stop === "reached" ? "Stop reaches the reply" : "Stop finds no reply";
    case "StopTimesOut":
      return "Stop times out after 10 s";
    case "ChangeArrives":
      return kindWords[to.kind] ?? "a coach change arrives";
    case "ChangeStarts":
      return to.change === "refused"
        ? "the coach refuses: a reply is running"
        : "the coach starts the change";
    case "BuildIoDone":
      return to.change === "draining" ? "the coach waits for the reply" : "the new coach is built";
    case "DeadlineFires":
      return "the change's 25 s deadline passes";
    case "ClientGivesUp":
      return "the app stops waiting for the change";
    case "ChangeFinishes":
      return to.change === "applied" ? "the change is applied" : "the coach drops the change";
    case "CfgReadArrives":
      return "Settings reads the coach route";
    case "CfgReadRuns":
      return "the route read answers";
    case "CfgReadTimesOut":
      return "the route read times out";
    case "PageReadArrives":
      return "Chat reads the transcript";
    case "PageReadAdmitted":
      return "the transcript read answers";
    case "PageReadTimesOut":
      return "the transcript read times out";
    case "Done":
      return null;
    default:
      return action;
  }
};

const label = (v: any) => {
  if (v.removed) return "Removed by you";
  if (v.match === "confirmed") return v.rideDay === "planned" ? "Done" : "Moved";
  if (v.seen && v.match === "suggested") return "Is this it?";
  if (v.day === "morning") return "Missed or not synced";
  return v.day === "before" ? "Planned" : "Day over, waiting for the morning";
};
export const title = "A Plan Workout's result on the calendar";
export const state = (v: any) => {
  const l = label(v);
  if (l !== "Missed or not synced") return l;
  return v.covered ? "Missed" : "Not synced yet";
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "DayEnds": return "the day ends";
    case "MorningComes": return "the next morning comes";
    case "YouRide": return "you ride";
    case "SyncRuns": return "a sync runs";
    case "YouConfirm": return "you press Confirm";
    case "NotThisOne": return "you press Not this one";
    case "YouPickThisRide": return "you pick this ride for it";
    case "YouKeepTheDelete": return "you keep a delete made in intervals.icu";
    case "Settled": return null;
  }
  return a;
};
export const group = (v: any) => (v.match === "confirmed" || v.removed ? "final" : v.day === "morning" ? "afterDay" : "open");
export const colors = { final: "teal", afterDay: "orange", open: "blue" };

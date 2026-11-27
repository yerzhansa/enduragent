export const title = "Training Weeks on intervals.icu (fill F1)";
const on = (v: any) => [1, 2, 3].filter((w) => v.sent[w]);
export const state = (v: any) => {
  if (v.consent === "none") return "Saved, first Change Set waiting";
  const missing = [v.now, v.now + 1].filter((w) => w <= 3 && !v.sent[w]);
  if (missing.length === 0) return "This week and next on intervals.icu";
  const waitsForYou = missing.every((w) => w > 2 && v.weekly && !v.okd[w]);
  if (waitsForYou) return "Next week waits for your Approve";
  return v.appOn && v.conn ? "Sending" : "Not sent: app closed or offline";
};
export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "AppRuns": return "the app runs";
    case "AWeekPasses": return "a week passes";
    case "YouApproveAtSave": return "you approve at Save";
    case "YouApproveTheWeek": return "you approve the week";
    case "YouQuitOrStartTheApp": return t.appOn ? "you start the app" : "you quit the app";
    case "ConnectionChanges": return t.conn ? "the connection comes back" : "the connection drops";
    case "End": return null;
  }
  return a;
};
export const group = (v: any) => (state(v) === "This week and next on intervals.icu" ? "ok" : "waiting");
export const colors = { ok: "teal", waiting: "orange" };

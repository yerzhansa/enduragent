import { exactKeys, record } from "./shape.js";

export function parseChatGptStatus(value: unknown): unknown {
  if (
    record(value) &&
    exactKeys(value, ["state", "runtimeReady", "reason"]) &&
    value.state === "configured" &&
    value.runtimeReady === false &&
    value.reason === "sign-in-expired"
  ) {
    return { state: "configured", runtimeReady: false, reason: "sign-in-expired" };
  }
  if (
    !record(value) ||
    !exactKeys(value, ["state", "runtimeReady"]) ||
    (value.state !== "configured" && value.state !== "absent") ||
    typeof value.runtimeReady !== "boolean"
  ) {
    throw new TypeError();
  }
  return { state: value.state, runtimeReady: value.runtimeReady };
}

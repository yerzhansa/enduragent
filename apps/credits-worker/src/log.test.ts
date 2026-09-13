import { afterEach, expect, it, vi } from "vitest";
import { consoleLog } from "./log.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["info", "log"],
  ["warn", "warn"],
] as const)("%s emits only route and outcome even with extra runtime fields", (level, method) => {
  const output = vi.spyOn(console, method).mockImplementation(() => {});
  const fields = {
    route: "apple",
    outcome: "revoked",
    athleteId: "synthetic-athlete",
    transactionId: "synthetic-transaction",
    token: "synthetic-token",
  };
  consoleLog[level](fields);
  expect(output).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ route: "apple", outcome: "revoked" }),
  );
});

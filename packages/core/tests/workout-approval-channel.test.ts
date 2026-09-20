import { describe, expect, it, vi } from "vitest";
import {
  createTerminalWorkoutApproval,
  deliverWorkoutReview,
  parseWorkoutCallback,
  type WorkoutApprovalChannel,
} from "../src/channels/workout-approval.js";

function fixture(kind: "approval" | "retry" = "approval") {
  const approvals: WorkoutApprovalChannel = {
    review: vi.fn(async () => ({ handle: "review", text: "Add Easy ride and edit Strength." })),
    acknowledgeDelivery: vi.fn(async () => ({
      kind,
      token: "synthetic_token_123456",
      prompt: "Review complete.",
    })),
    resolve: vi.fn(async () => ({ kind: "completed" as const, text: "Saved." })),
  };
  return approvals;
}

describe("workout approval channel", () => {
  it("does not acknowledge or show a control after incomplete delivery", async () => {
    const approvals = fixture();
    const controls = vi.fn();
    await expect(
      deliverWorkoutReview({
        approvals,
        chatId: "cli",
        language: "en",
        deliver: async () => {
          throw new Error("incomplete delivery");
        },
        controls,
      }),
    ).rejects.toThrow("incomplete delivery");
    expect(approvals.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(controls).not.toHaveBeenCalled();
  });

  it("does not show controls if the saved review changes during delivery", async () => {
    const approvals = fixture();
    approvals.acknowledgeDelivery = vi.fn(async () => null);
    const controls = vi.fn();
    await deliverWorkoutReview({
      approvals,
      chatId: "cli",
      language: "en",
      deliver: async () => {},
      controls,
    });
    expect(controls).not.toHaveBeenCalled();
  });

  it("preserves a terminal approval while ordinary revision text goes to the coach", async () => {
    const approvals = fixture();
    const terminal = createTerminalWorkoutApproval({
      approvals,
      language: () => "en",
      output: async () => {},
    });
    await terminal.present();
    expect(await terminal.handle("Make Thursday easier")).toBe(false);
    expect(approvals.resolve).not.toHaveBeenCalled();
    approvals.review = vi.fn(async () => null);
    expect(await terminal.handle("approve")).toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith({
      chatId: "cli",
      language: "en",
      action: { kind: "approve", token: "synthetic_token_123456" },
    });
    expect(await terminal.handle("approve")).toBe(false);
  });

  it("requires the offered retry action after partial execution", async () => {
    const approvals = fixture("retry");
    const terminal = createTerminalWorkoutApproval({
      approvals,
      language: () => "en",
      output: async () => {},
    });
    await terminal.present();
    expect(await terminal.handle("approve")).toBe(false);
    expect(approvals.resolve).not.toHaveBeenCalled();
    approvals.review = vi.fn(async () => null);
    expect(await terminal.handle("retry")).toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith({
      chatId: "cli",
      language: "en",
      action: { kind: "retry-remaining", token: "synthetic_token_123456" },
    });
  });

  it("binds cancellation to the displayed review", async () => {
    const approvals = fixture();
    const terminal = createTerminalWorkoutApproval({
      approvals,
      language: () => "en",
      output: async () => {},
    });
    await terminal.present();
    approvals.review = vi.fn(async () => null);
    expect(await terminal.handle("cancel")).toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith({
      chatId: "cli",
      language: "en",
      action: { kind: "cancel", token: "synthetic_token_123456" },
    });
  });

  it("accepts only bounded workout callback actions", () => {
    expect(parseWorkoutCallback("wc:retry:synthetic_token_123456")).toEqual({
      kind: "retry-remaining",
      token: "synthetic_token_123456",
    });
    for (const data of [
      "cg:y:synthetic_token_123456",
      "wc:approve:short",
      "wc:delete:synthetic_token_123456",
      `wc:approve:${"a".repeat(49)}`,
    ]) {
      expect(parseWorkoutCallback(data)).toBeNull();
    }
  });
});

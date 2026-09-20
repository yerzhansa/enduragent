import type { WorkoutChangeSets, ArmedControl, Action } from "../workout-change-sets/service.js";
import { workoutPhrasebook } from "../workout-change-sets/copy.js";

export type WorkoutApprovalChannel = Pick<
  WorkoutChangeSets,
  "review" | "acknowledgeDelivery" | "resolve"
>;

export function parseWorkoutCallback(data: string): Action | null {
  const match = /^wc:(approve|retry|cancel):([A-Za-z0-9_-]{16,48})$/.exec(data);
  if (match === null) return null;
  const token = match[2];
  if (token === undefined) return null;
  if (match[1] === "approve") return { kind: "approve", token };
  if (match[1] === "retry") return { kind: "retry-remaining", token };
  return { kind: "cancel", token };
}

export async function deliverWorkoutReview(input: {
  readonly approvals: WorkoutApprovalChannel;
  readonly chatId: string;
  readonly language: string;
  readonly redisplay?: boolean;
  readonly deliver: (text: string) => Promise<void>;
  readonly controls: (control: ArmedControl) => Promise<void>;
}): Promise<boolean> {
  const review = await input.approvals.review({
    chatId: input.chatId,
    language: input.language,
    redisplay: input.redisplay,
  });
  if (review === null) return false;
  await input.deliver(review.text);
  if (review.handle === null) return true;
  const control = await input.approvals.acknowledgeDelivery({
    chatId: input.chatId,
    delivery: review.handle,
    language: input.language,
  });
  if (control !== null) await input.controls(control);
  return true;
}

export function createTerminalWorkoutApproval(input: {
  readonly approvals: WorkoutApprovalChannel;
  readonly language: () => string;
  readonly output: (text: string) => Promise<void>;
}) {
  let control: ArmedControl | null = null;
  const present = async (redisplay = false): Promise<void> => {
    await deliverWorkoutReview({
      approvals: input.approvals,
      chatId: "cli",
      language: input.language(),
      redisplay,
      deliver: input.output,
      controls: async (next) => {
        const book = await workoutPhrasebook(input.language());
        await input.output(
          `${next.prompt}\n${book.say("workouts.approval.terminalPrompt", {
            action: next.kind === "retry" ? "retry" : "approve",
            cancel: "cancel",
          })}`,
        );
        control = next;
      },
    });
  };
  return {
    present,
    async handle(line: string): Promise<boolean> {
      if (control === null) return false;
      const command = line.trim().toLowerCase();
      const kind =
        command === "cancel" || command === "/cancel" || command === "n" || command === "no"
          ? "cancel"
          : control.kind === "approval" &&
              (command === "approve" ||
                command === "/approve" ||
                command === "y" ||
                command === "yes")
            ? "approve"
            : control.kind === "retry" && (command === "retry" || command === "/retry")
              ? "retry-remaining"
              : null;
      if (kind === null) return false;
      const token = control.token;
      control = null;
      const outcome = await input.approvals.resolve({
        chatId: "cli",
        action: { kind, token },
        language: input.language(),
      });
      await input.output(outcome.text);
      await present();
      return true;
    },
  };
}

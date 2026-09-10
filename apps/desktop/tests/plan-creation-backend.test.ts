import { expect, it } from "vitest";
import { PlanCreationBackend } from "./helpers/plan-creation-backend.js";

it("forwards ordinary coaching events when the backend also streams answer checks", async () => {
  const backend = new PlanCreationBackend(":memory:");
  await backend.script.onRequest({
    method: "enqueueChatMessage",
    params: { submissionId: "ordinary-message", text: "How easy should an easy ride feel?" },
  });
  const events: unknown[] = [];
  const result = await backend.script.onStreamRequest?.(
    { method: "resumeChatQueue", params: {} },
    (frame) => events.push(JSON.parse(frame)),
  );
  expect(events).toEqual([
    { type: "turn-start", turnId: "ordinary-turn-1", chatId: "desktop" },
    {
      type: "text_delta",
      turnId: "ordinary-turn-1",
      delta: "Keep the effort conversational and finish feeling fresh.",
    },
    {
      type: "final-text",
      turnId: "ordinary-turn-1",
      text: "Keep the effort conversational and finish feeling fresh.",
    },
  ]);
  expect(JSON.parse(result ?? "null")).toMatchObject({
    snapshot: { items: [] },
    response: { text: "Keep the effort conversational and finish feeling fresh." },
  });
});

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createReconfigurableRuntimeBundle, type RuntimeBundle } from "../src/runtime-bundle.js";
import { createSpendMeterService } from "../src/spend-meter.js";

type Runtime = ReturnType<typeof createReconfigurableRuntimeBundle>;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function fakeBundle(name: string, hold: Promise<void>): RuntimeBundle {
  const held = async (value: unknown) => {
    await hold;
    return value;
  };
  const page = { schemaVersion: 1, status: "page", turns: [], nextCursor: null, from: name };
  return {
    intentTranslator: { translateIntent: () => held(name) },
    coachText: { writeCoachText: () => held(name) },
    engine: {
      chat: () => held({ text: name }),
      stopChat: async () => ({ stopped: true, from: name }),
      getChatQueue: async () => ({ schemaVersion: 1, revision: 0, items: [], from: name }),
      resumeChatQueue: () => held({ from: name }),
      runQueuedCommand: () => held({ from: name }),
      retryQueuedTurn: () => held({ from: name }),
      answerCoachDecision: () => held({ from: name }),
      resumeCoachDecision: () => held({ from: name }),
      hasSession: () => held({ hasSession: name === "old" }),
    },
    chatStore: {
      readCurrentConversationPage: async () => page,
      listArchivedConversations: async () => ({ conversations: [], from: name }),
    },
    timezone: "UTC",
  } as unknown as RuntimeBundle;
}

const TURNS: readonly [string, (runtime: Runtime) => Promise<unknown>][] = [
  ["chat", (runtime) => runtime.engine.chat({ chatId: "desktop", message: "Plan my week." })],
  ["resumeChatQueue", (runtime) => runtime.engine.resumeChatQueue!({ chatId: "desktop" } as never)],
  ["runQueuedCommand", (runtime) => runtime.engine.runQueuedCommand!({} as never)],
  ["retryQueuedTurn", (runtime) => runtime.engine.retryQueuedTurn!({} as never)],
  ["answerCoachDecision", (runtime) => runtime.engine.answerCoachDecision({} as never)],
  ["resumeCoachDecision", (runtime) => runtime.engine.resumeCoachDecision({} as never)],
  [
    "translateIntent",
    (runtime) => runtime.intentTranslator.translateIntent("move my ride", z.string(), {} as never),
  ],
  [
    "writeCoachText",
    (runtime) => runtime.coachText.writeCoachText({} as never, new AbortController().signal),
  ],
];

async function settledSoon(promise: Promise<unknown>): Promise<"settled" | "pending"> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return settled ? "settled" : "pending";
}

describe("reconfigurable runtime bundle", () => {
  it("saves the cap mode through to the active spend meter's cap file", async () => {
    const home = await mkdtemp(join(tmpdir(), "runtime-bundle-cap-"));
    try {
      await mkdir(join(home, "config"));
      const spendMeter = createSpendMeterService({
        dataDir: home,
        configDir: join(home, "config"),
        timezone: "UTC",
      });
      const runtime = createReconfigurableRuntimeBundle({
        ...fakeBundle("old", Promise.resolve()),
        spendMeter,
      } as RuntimeBundle);

      const stopped = await runtime.spendMeter.setDailySpendCap(2, "enforce");
      const raised = await runtime.spendMeter.setDailySpendCap(3);

      expect(stopped).toMatchObject({ dailyCapUsd: 2, capMode: "enforce" });
      expect(raised).toMatchObject({ dailyCapUsd: 3, capMode: "enforce" });
      expect(
        JSON.parse(await readFile(join(home, "config", "daily-spend-cap.json"), "utf8")),
      ).toEqual({ version: 2, dailyCapUsd: 3, mode: "enforce" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(TURNS)(
    "refuses a replacement while %s runs and leaves Stop and reads unblocked",
    async (_name, startTurn) => {
      const turn = gate();
      const runtime = createReconfigurableRuntimeBundle(fakeBundle("old", turn.opened));
      const replacement = fakeBundle("new", Promise.resolve());
      const prepare = vi.fn(() => replacement);
      const commit = vi.fn((prepared: RuntimeBundle) => prepared);
      const running = startTurn(runtime);
      await Promise.resolve();

      await expect(runtime.replace(prepare, commit, "refuse")).resolves.toBe("busy-replying");
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();

      const stop = runtime.engine.stopChat!({ chatId: "desktop", turnId: "turn-1" });
      const transcript = runtime.getTranscriptPage({ cursor: null, limit: 25 });
      const archive = runtime.listArchivedConversations({});
      const queue = runtime.engine.getChatQueue!({ chatId: "desktop" });
      expect({
        stop: await settledSoon(stop),
        transcript: await settledSoon(transcript),
        archive: await settledSoon(archive),
        queue: await settledSoon(queue),
        turn: await settledSoon(running),
      }).toEqual({
        stop: "settled",
        transcript: "settled",
        archive: "settled",
        queue: "settled",
        turn: "pending",
      });
      await expect(stop).resolves.toEqual({ stopped: true, from: "old" });
      await expect(transcript).resolves.toMatchObject({ from: "old" });

      turn.open();
      await running;
      await expect(runtime.replace(prepare, commit, "refuse")).resolves.toBe("replaced");
      expect(commit).toHaveBeenCalledOnce();
      await expect(runtime.getTranscriptPage({ cursor: null, limit: 25 })).resolves.toMatchObject({
        from: "new",
      });
    },
  );

  it("drains a running turn before a waiting replacement commits", async () => {
    const turn = gate();
    const runtime = createReconfigurableRuntimeBundle(fakeBundle("old", turn.opened));
    const commit = vi.fn((prepared: RuntimeBundle) => prepared);
    const running = runtime.engine.chat({ chatId: "desktop", message: "Plan my week." });
    await Promise.resolve();

    const replacement = runtime.replace(() => fakeBundle("new", Promise.resolve()), commit, "wait");
    expect(await settledSoon(replacement)).toBe("pending");
    expect(commit).not.toHaveBeenCalled();

    turn.open();
    await expect(running).resolves.toEqual({ text: "old" });
    await expect(replacement).resolves.toBe("replaced");
    expect(commit).toHaveBeenCalledOnce();
    await expect(
      runtime.engine.chat({ chatId: "desktop", message: "And next week?" }),
    ).resolves.toEqual({ text: "new" });
  });

  it("refuses a change while a reply waits to start behind a waiting replacement", async () => {
    const shortCall = gate();
    const runtime = createReconfigurableRuntimeBundle(fakeBundle("old", shortCall.opened));
    const pending = runtime.engine.hasSession({ chatId: "desktop" });
    await Promise.resolve();
    const unchanged = runtime.replace(
      () => fakeBundle("old", Promise.resolve()),
      (prepared) => prepared,
      "wait",
    );
    const waitingReply = runtime.engine.chat({ chatId: "desktop", message: "Plan my week." });
    await Promise.resolve();

    await expect(
      runtime.replace(
        () => fakeBundle("new", Promise.resolve()),
        (prepared) => prepared,
        "refuse",
      ),
    ).resolves.toBe("busy-replying");

    shortCall.open();
    await pending;
    await expect(unchanged).resolves.toBe("replaced");
    await expect(waitingReply).resolves.toEqual({ text: "old" });
  });

  it("waits for a short call to finish when it replaces with refuse", async () => {
    const call = gate();
    const runtime = createReconfigurableRuntimeBundle(fakeBundle("old", call.opened));
    const commit = vi.fn((prepared: RuntimeBundle) => prepared);
    const shortCall = runtime.engine.hasSession({ chatId: "desktop" });
    await Promise.resolve();

    const replacement = runtime.replace(
      () => fakeBundle("new", Promise.resolve()),
      commit,
      "refuse",
    );
    expect(await settledSoon(replacement)).toBe("pending");
    expect(commit).not.toHaveBeenCalled();

    call.open();
    await expect(shortCall).resolves.toEqual({ hasSession: true });
    await expect(replacement).resolves.toBe("replaced");
    await expect(runtime.engine.hasSession({ chatId: "desktop" })).resolves.toEqual({
      hasSession: false,
    });
  });
});

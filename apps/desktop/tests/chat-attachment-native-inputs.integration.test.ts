import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CHAT_ATTACHMENT_LIMITS,
  type AdmitChatAttachmentRequest,
  type AdmitPastedChatAttachmentRequest,
  type AttachmentCapabilitiesReadModel,
} from "@enduragent/coach-contract";
import {
  createChatAttachmentRepository,
  runMigrations,
  type ChatAttachmentRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createManagedChatAttachmentStore } from "@enduragent/kernel-node/chat-attachments";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAttachmentComposerOperations,
  type AttachmentComposerOperations,
} from "../../../packages/coach/src/attachment-composer-operations.js";
import {
  createManagedChatAttachmentOperations,
  type ManagedChatAttachmentOperations,
} from "../../../packages/coach/src/attachment-operations.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";
import { createPlanQaFixtureScript } from "./helpers/plan-qa-live.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "a".repeat(43);
const chatId = "desktop";
const draftText = "Compare these synthetic notes without exposing their source.";
const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const fixtures: RunningDesktopFixture[] = [];
const backends: NativeAttachmentBackend[] = [];
const scratchPaths: string[] = [];
const execFile = promisify(execFileCallback);

const clipboardArchiveScript = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

function readPasteboard(pasteboard) {
  const pasteboardItems = pasteboard.pasteboardItems;
  if (pasteboardItems.isNil()) return [];
  return pasteboardItems.js.map((item) => ({
    representations: item.types.js.map((type) => {
      const data = item.dataForType(type);
      if (data.isNil()) throw new Error("clipboard representation is unavailable");
      return {
        type: ObjC.unwrap(type),
        data: ObjC.unwrap(data.base64EncodedStringWithOptions(0)),
      };
    }),
  }));
}

function readArchive(path) {
  const value = $.NSString.stringWithContentsOfFileEncodingError(
    $(path),
    $.NSUTF8StringEncoding,
    null,
  );
  if (value.isNil()) throw new Error("clipboard archive is unavailable");
  return JSON.parse(ObjC.unwrap(value));
}

function writeArchiveFile(path, archive) {
  const value = $(JSON.stringify(archive));
  if (!value.writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null)) {
    throw new Error("clipboard archive could not be written");
  }
}

function normalize(archive) {
  return archive.map((item) => ({
    representations: item.representations
      .map((representation) => ({
        type: representation.type,
        data: representation.data,
      }))
      .sort((left, right) => left.type.localeCompare(right.type)),
  }));
}

function equalArchive(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function makePasteboardItems(archive) {
  return archive.map((entry) => {
    const item = $.NSPasteboardItem.alloc.init;
    for (const representation of entry.representations) {
      const data = $.NSData.alloc.initWithBase64EncodedStringOptions(
        $(representation.data),
        0,
      );
      if (data.isNil() || !item.setDataForType(data, $(representation.type))) {
        throw new Error("clipboard representation could not be reconstructed");
      }
    }
    return item;
  });
}

function writePasteboard(pasteboard, archive) {
  const items = makePasteboardItems(archive);
  const reconstructed = items.map((item) => ({
    representations: item.types.js.map((type) => ({
      type: ObjC.unwrap(type),
      data: ObjC.unwrap(item.dataForType(type).base64EncodedStringWithOptions(0)),
    })),
  }));
  if (!equalArchive(reconstructed, archive)) {
    throw new Error("clipboard reconstruction did not preserve every representation");
  }
  pasteboard.clearContents;
  if (items.length > 0 && !pasteboard.writeObjects($(items))) {
    throw new Error("clipboard representations could not be restored");
  }
  if (!equalArchive(readPasteboard(pasteboard), archive)) {
    throw new Error("clipboard restoration did not preserve every representation");
  }
}

function imageArchive(path) {
  const data = $.NSData.dataWithContentsOfFile($(path));
  if (data.isNil()) throw new Error("synthetic clipboard image is unavailable");
  return [{
    representations: [{
      type: "public.png",
      data: ObjC.unwrap(data.base64EncodedStringWithOptions(0)),
    }],
  }];
}

function summary(archive, state) {
  return Object.assign({
    itemCount: archive.length,
    representationCount: archive.reduce(
      (count, item) => count + item.representations.length,
      0,
    ),
  }, state);
}

function run(args) {
  const action = args[0];
  const archivePath = args[1];
  const imagePath = args[2];
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const original = action === "snapshot" ? readPasteboard(pasteboard) : readArchive(archivePath);
  if (action === "snapshot") {
    writeArchiveFile(archivePath, original);
    const probe = $.NSPasteboard.pasteboardWithUniqueName;
    try {
      writePasteboard(probe, original);
    } finally {
      probe.releaseGlobally;
    }
    return JSON.stringify(summary(original, { snapshotted: true }));
  }
  const synthetic = imageArchive(imagePath);
  const current = readPasteboard(pasteboard);
  if (action === "write-image") {
    if (!equalArchive(current, original)) {
      return JSON.stringify(summary(current, { written: false, concurrentChange: true }));
    }
    writePasteboard(pasteboard, synthetic);
    return JSON.stringify(summary(synthetic, { written: true, concurrentChange: false }));
  }
  if (action === "restore") {
    if (equalArchive(current, original)) {
      return JSON.stringify(summary(original, {
        restored: true,
        alreadyOriginal: true,
        concurrentChange: false,
      }));
    }
    if (!equalArchive(current, synthetic)) {
      return JSON.stringify(summary(current, {
        restored: false,
        alreadyOriginal: false,
        concurrentChange: true,
      }));
    }
    writePasteboard(pasteboard, original);
    return JSON.stringify(summary(original, {
      restored: true,
      alreadyOriginal: false,
      concurrentChange: false,
    }));
  }
  throw new Error("unsupported clipboard archive action");
}
`;

interface ClipboardArchiveResult {
  readonly itemCount: number;
  readonly representationCount: number;
  readonly snapshotted?: boolean;
  readonly written?: boolean;
  readonly restored?: boolean;
  readonly alreadyOriginal?: boolean;
  readonly concurrentChange?: boolean;
}

async function operateClipboard(
  action: "snapshot" | "write-image" | "restore",
  archivePath: string,
  imagePath: string,
): Promise<ClipboardArchiveResult> {
  const { stdout } = await execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", clipboardArchiveScript, "--", action, archivePath, imagePath],
    { maxBuffer: 1024 * 1024 },
  );
  if (action === "snapshot") await chmod(archivePath, 0o600);
  return JSON.parse(stdout.trim()) as ClipboardArchiveResult;
}

const capabilities: AttachmentCapabilitiesReadModel = {
  schemaVersion: 1,
  active: { provider: "test", model: "native-inputs", transport: "test" },
  documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
  completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
  plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
  images: {
    enabled: true,
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    reason: "supported",
    source: "maintained_catalogue",
    checkedAt: "1998-08-22T08:00:00.000Z",
  },
};

interface ScriptRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

class NativeAttachmentBackend {
  readonly calls: ScriptRequest[] = [];
  readonly generatedIds: string[] = [];
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: ChatAttachmentRepository | undefined;
  private attachments: ManagedChatAttachmentOperations | undefined;
  private composer: AttachmentComposerOperations | undefined;
  private instant = Date.UTC(1998, 7, 22, 8);

  constructor(
    private readonly databasePath: string,
    private readonly archiveDir: string,
  ) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "admitChatAttachment") {
          return response(
            await this.requireAttachments().admit(request.params as AdmitChatAttachmentRequest),
          );
        }
        if (request.method === "admitPastedChatAttachment") {
          const input = request.params as AdmitPastedChatAttachmentRequest;
          const bytes = Buffer.from(input.dataBase64, "base64");
          if (bytes.byteLength === 0 || bytes.toString("base64") !== input.dataBase64) {
            return response({
              selectionId: input.selectionId,
              displayName: input.displayName,
              status: "rejected",
              reason: "validation_failed",
            });
          }
          return response(
            await this.requireAttachments().admitPasted({
              chatId: input.chatId,
              selectionId: input.selectionId,
              displayName: input.displayName,
              bytes,
            }),
          );
        }
        if (request.method === "getChatAttachmentComposer") {
          return response(await this.requireComposer().read(String(request.params.chatId)));
        }
        if (request.method === "saveChatAttachmentDraftText") {
          return response(
            await this.requireComposer().saveText(
              String(request.params.chatId),
              String(request.params.text),
            ),
          );
        }
        if (request.method === "removeChatAttachment") {
          return response(
            await this.requireComposer().remove(
              String(request.params.chatId),
              String(request.params.attachmentId),
            ),
          );
        }
        if (request.method === "retryChatAttachment") {
          return response(
            await this.requireComposer().retry(
              String(request.params.chatId),
              String(request.params.attachmentId),
            ),
          );
        }
        if (request.method === "selectChatAttachmentWorkout") {
          return response(
            await this.requireComposer().selectWorkout(
              String(request.params.chatId),
              String(request.params.attachmentId),
              String(request.params.workoutId),
            ),
          );
        }
        if (request.method === "clearChatAttachmentDraft") {
          return response(await this.requireComposer().clear(String(request.params.chatId)));
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: null });
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    const store = openSqliteStorage(this.databasePath);
    await runMigrations(store, MIGRATIONS);
    this.store = store;
    const repository = createChatAttachmentRepository(store);
    this.repository = repository;
    const objects = createManagedChatAttachmentStore({
      archiveDir: this.archiveDir,
      kindByteLimits: {
        document: CHAT_ATTACHMENT_LIMITS.documentBytes,
        activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
        workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
        image: CHAT_ATTACHMENT_LIMITS.imageBytes,
      },
    });
    const attachments = createManagedChatAttachmentOperations({
      repository,
      objects,
      runExclusive: (work) => work(),
      now: () => ++this.instant,
      randomId: () => {
        const id = `native-input-id-${this.generatedIds.length + 1}`;
        this.generatedIds.push(id);
        return id;
      },
      onAdmitted: async ({ attachment }) => {
        const stateJson =
          attachment.kind === "image"
            ? JSON.stringify({ mediaType: attachment.media_type, width: 1, height: 1 })
            : JSON.stringify({ extractedTextChars: 32, visualPageNumbers: [] });
        await repository.transitionAttachment({
          conversationId: attachment.conversation_id,
          attachmentId: attachment.id,
          from: ["preprocessing"],
          to: "ready",
          stateJson,
          messageId: null,
          updatedAtMs: ++this.instant,
        });
      },
    });
    this.attachments = attachments;
    this.composer = createAttachmentComposerOperations({
      repository,
      attachments,
      activities: {
        readPreview: async () => {
          throw new TypeError("activity preview is outside this fixture");
        },
      },
      workouts: {
        readWorkoutSet: async () => {
          throw new TypeError("Workout preview is outside this fixture");
        },
        selectWorkout: async () => {
          throw new TypeError("Workout selection is outside this fixture");
        },
      },
      capabilities: async () => capabilities,
    });
  }

  async snapshot() {
    const composer = await this.requireComposer().read(chatId);
    return {
      composer,
      attachmentIds: composer.draft?.attachments.map((attachment) => attachment.attachmentId) ?? [],
    };
  }

  async close(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.repository = undefined;
    this.attachments = undefined;
    this.composer = undefined;
    if (store !== undefined) await store.close();
  }

  private requireAttachments(): ManagedChatAttachmentOperations {
    if (this.attachments === undefined) throw new TypeError("attachment operations are closed");
    return this.attachments;
  }

  private requireComposer(): AttachmentComposerOperations {
    if (this.composer === undefined) throw new TypeError("attachment composer is closed");
    return this.composer;
  }
}

async function waitForAttachments(
  fixture: RunningDesktopFixture,
  expectedNames: readonly string[],
): Promise<{
  readonly names: readonly string[];
  readonly draft: string;
  readonly html: string;
}> {
  return fixture.evaluate(`
    const expected = ${JSON.stringify(expectedNames)};
    const deadline = Date.now() + 15000;
    let names = [];
    let textarea;
    while (Date.now() < deadline) {
      names = [...document.querySelectorAll('section[aria-label$=" attachment"]')].map(
        (section) => section.getAttribute("aria-label")?.replace(/ attachment$/u, "") ?? "",
      );
      textarea = document.querySelector("#message");
      if (
        textarea instanceof HTMLTextAreaElement &&
        textarea.value === ${JSON.stringify(draftText)} &&
        JSON.stringify(names) === JSON.stringify(expected)
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Chat composer is missing");
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error("Unexpected attachment order: " + JSON.stringify(names));
    }
    return {
      names,
      draft: textarea.value,
      html: document.documentElement.outerHTML,
    };
  `);
}

async function removeAttachment(
  fixture: RunningDesktopFixture,
  displayName: string,
): Promise<void> {
  await fixture.evaluate(`
    const label = ${JSON.stringify(`${displayName} attachment`)};
    const section = [...document.querySelectorAll('section[aria-label$=" attachment"]')].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    const remove = section?.querySelector("button");
    if (!(remove instanceof HTMLButtonElement) || remove.textContent?.trim() !== "Remove") {
      throw new Error("Attachment remove action is missing");
    }
    remove.click();
  `);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat native attachment inputs",
  () => {
    it("keeps picker, drop, and pasted files independent through middle removal", async () => {
      const scratch = await mkdtemp(join(await realpath(tmpdir()), "chat-native-inputs-"));
      scratchPaths.push(scratch);
      const evidenceDir = process.env.ATT_01_EVIDENCE_DIR;
      if (evidenceDir !== undefined) await mkdir(evidenceDir, { recursive: true });
      const sourceDir = join(scratch, "synthetic-source");
      await mkdir(sourceDir, { recursive: true, mode: 0o700 });
      const pickerNames = [
        "alpha-notes.txt",
        "bravo-notes.txt",
        "charlie-notes.txt",
        "delta-notes.txt",
        "echo-notes.txt",
        "foxtrot-ignored.txt",
      ];
      const pickerPaths = pickerNames.map((name) => join(sourceDir, name));
      const dropName = "golf-notes.txt";
      const dropPath = join(sourceDir, dropName);
      const rejectedName = "hotel-unsupported.xyz";
      const rejectedPath = join(sourceDir, rejectedName);
      const pastedImagePath = join(sourceDir, "india-pasted-1998.png");
      await Promise.all([
        ...pickerPaths.map((path, index) =>
          writeFile(path, `Synthetic note ${index + 1} from 1998.`, { mode: 0o600 }),
        ),
        writeFile(dropPath, "Synthetic dropped note from 1998.", { mode: 0o600 }),
        writeFile(rejectedPath, "Synthetic unsupported note from 1998.", { mode: 0o600 }),
        writeFile(pastedImagePath, syntheticPng, { mode: 0o600 }),
      ]);

      const backend = new NativeAttachmentBackend(
        join(scratch, "native-inputs.sqlite"),
        join(scratch, "archive"),
      );
      backends.push(backend);
      await backend.open();
      const fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: evidenceDir === undefined,
        inspectMain: true,
        routeChatAttachmentComposer: true,
        routeChatAttachmentOperations: true,
      });
      fixtures.push(fixture);

      await fixture.evaluate(`
        const deadline = Date.now() + 10000;
        let textarea;
        let attach;
        while (Date.now() < deadline) {
          textarea = document.querySelector("#message");
          attach = document.querySelector('button[aria-label="Attach files"]');
          if (
            textarea instanceof HTMLTextAreaElement &&
            attach instanceof HTMLButtonElement &&
            !textarea.disabled &&
            !attach.disabled
          ) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Chat composer is missing");
        if (!(attach instanceof HTMLButtonElement) || attach.disabled) {
          throw new Error("Attachment picker is unavailable");
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, ${JSON.stringify(draftText)});
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      `);

      expect(
        await fixture.evaluateMain(`
          const require = process.getBuiltinModule("module").createRequire(
            process.cwd() + "/package.json",
          );
          const electron = require("electron");
          electron.dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: ${JSON.stringify(pickerPaths)},
          });
          return true;
        `),
      ).toBe(true);
      await fixture.evaluate(`
        const attach = document.querySelector('button[aria-label="Attach files"]');
        if (!(attach instanceof HTMLButtonElement)) throw new Error("Attachment picker is missing");
        attach.click();
      `);

      const pickedNames = pickerNames.slice(0, 5);
      expect(await waitForAttachments(fixture, pickedNames)).toMatchObject({
        names: pickedNames,
        draft: draftText,
      });
      if (evidenceDir !== undefined) {
        await fixture.screenshot(join(evidenceDir, "att-01-picker-five.png"));
      }
      const picked = await backend.snapshot();
      expect(picked.attachmentIds).toHaveLength(5);
      const pickerAdmissions = backend.calls.filter(
        (call) => call.method === "admitChatAttachment" && call.params.source === "picker",
      );
      expect(pickerAdmissions).toHaveLength(5);
      expect(
        pickerAdmissions.map(
          (call) => (call.params.candidate as { readonly sourcePath: string }).sourcePath,
        ),
      ).toEqual(pickerPaths.slice(0, 5));
      expect(new Set(pickerAdmissions.map((call) => call.params.selectionId)).size).toBe(5);

      await removeAttachment(fixture, "charlie-notes.txt");
      const afterRemovalNames = [
        "alpha-notes.txt",
        "bravo-notes.txt",
        "delta-notes.txt",
        "echo-notes.txt",
      ];
      await waitForAttachments(fixture, afterRemovalNames);
      const afterRemoval = await backend.snapshot();
      expect(afterRemoval.attachmentIds).toEqual([
        picked.attachmentIds[0],
        picked.attachmentIds[1],
        picked.attachmentIds[3],
        picked.attachmentIds[4],
      ]);

      await fixture.dropFiles('[data-chat-attachment-dropzone="true"]', [dropPath]);
      const afterDropNames = [
        "alpha-notes.txt",
        "bravo-notes.txt",
        dropName,
        "delta-notes.txt",
        "echo-notes.txt",
      ];
      await waitForAttachments(fixture, afterDropNames);
      const afterDrop = await backend.snapshot();
      expect(afterDrop.attachmentIds).toEqual([
        picked.attachmentIds[0],
        picked.attachmentIds[1],
        expect.any(String),
        picked.attachmentIds[3],
        picked.attachmentIds[4],
      ]);
      expect(afterDrop.attachmentIds[2]).not.toBe(picked.attachmentIds[2]);
      if (evidenceDir !== undefined) {
        await fixture.screenshot(join(evidenceDir, "att-01-middle-removal-drop.png"));
      }

      await removeAttachment(fixture, "delta-notes.txt");
      await waitForAttachments(fixture, [
        "alpha-notes.txt",
        "bravo-notes.txt",
        dropName,
        "echo-notes.txt",
      ]);
      const clipboardArchivePath = join(scratch, "clipboard-archive.json");
      const clipboardBefore = await operateClipboard(
        "snapshot",
        clipboardArchivePath,
        pastedImagePath,
      );
      expect(clipboardBefore.snapshotted).toBe(true);
      let clipboardAfter: ClipboardArchiveResult | undefined;
      let scenarioFailure: unknown;
      try {
        const clipboardWrite = await operateClipboard(
          "write-image",
          clipboardArchivePath,
          pastedImagePath,
        );
        expect(clipboardWrite).toMatchObject({
          itemCount: 1,
          representationCount: 1,
          written: true,
          concurrentChange: false,
        });
        await fixture.evaluate(`
          const textarea = document.querySelector("#message");
          if (!(textarea instanceof HTMLTextAreaElement)) {
            throw new Error("Chat composer is missing");
          }
          textarea.focus();
        `);
        await fixture.pressKey("v", { meta: true });
        const finalNames = [
          "alpha-notes.txt",
          "bravo-notes.txt",
          dropName,
          "Pasted image.png",
          "echo-notes.txt",
        ];
        const pastedSurface = await waitForAttachments(fixture, finalNames);
        if (evidenceDir !== undefined) {
          await fixture.screenshot(join(evidenceDir, "att-01-image-paste.png"));
        }
        const afterPaste = await backend.snapshot();
        expect(afterPaste.attachmentIds).toEqual([
          picked.attachmentIds[0],
          picked.attachmentIds[1],
          afterDrop.attachmentIds[2],
          expect.any(String),
          picked.attachmentIds[4],
        ]);

        await fixture.dropFiles('[data-chat-attachment-dropzone="true"]', [rejectedPath]);
        const rejectedSurface = await fixture.evaluate<{
          readonly names: readonly string[];
          readonly draft: string;
          readonly rejectionCount: number;
          readonly html: string;
        }>(`
          const expected = ${JSON.stringify(finalNames)};
          const deadline = Date.now() + 10000;
          let names = [];
          let rejectionCount = 0;
          while (Date.now() < deadline) {
            names = [...document.querySelectorAll('section[aria-label$=" attachment"]')].map(
              (section) => section.getAttribute("aria-label")?.replace(/ attachment$/u, "") ?? "",
            );
            rejectionCount = [...document.querySelectorAll('[role="alert"]')].filter(
              (alert) => alert.textContent?.includes("This file type isn’t supported"),
            ).length;
            if (JSON.stringify(names) === JSON.stringify(expected) && rejectionCount === 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const textarea = document.querySelector("#message");
          return {
            names,
            draft: textarea instanceof HTMLTextAreaElement ? textarea.value : "",
            rejectionCount,
            html: document.documentElement.outerHTML,
          };
        `);
        expect(rejectedSurface).toMatchObject({
          names: finalNames,
          draft: draftText,
          rejectionCount: 1,
        });
        if (evidenceDir !== undefined) {
          await fixture.screenshot(join(evidenceDir, "att-01-rejection-preserves-draft.png"));
        }
        expect((await backend.snapshot()).attachmentIds).toEqual(afterPaste.attachmentIds);

        const privateValues = [
          scratch,
          sourceDir,
          ...pickerPaths,
          dropPath,
          rejectedPath,
          pastedImagePath,
          syntheticPng.toString("base64"),
          ...backend.generatedIds,
          ...pickerPaths.map((_, index) => `Synthetic note ${index + 1} from 1998.`),
          "Synthetic dropped note from 1998.",
          "Synthetic unsupported note from 1998.",
        ];
        for (const privateValue of privateValues) {
          expect(pastedSurface.html).not.toContain(privateValue);
          expect(rejectedSurface.html).not.toContain(privateValue);
        }
      } catch (error) {
        scenarioFailure = error;
      } finally {
        try {
          clipboardAfter = await operateClipboard("restore", clipboardArchivePath, pastedImagePath);
        } finally {
          await rm(clipboardArchivePath, { force: true });
        }
      }
      if (clipboardAfter?.restored !== true) {
        throw new Error("macOS clipboard ownership changed before restoration");
      }
      if (scenarioFailure !== undefined) throw scenarioFailure;
      expect(clipboardAfter).toMatchObject({
        itemCount: clipboardBefore.itemCount,
        representationCount: clipboardBefore.representationCount,
        restored: true,
        concurrentChange: false,
      });

      expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      fixtures.splice(fixtures.indexOf(fixture), 1);
    }, 180_000);
  },
);

import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type {
  CredentialDeleteResult,
  CredentialRecoveryStatus,
  CredentialResetResult,
  DesktopCredentialId,
} from "../src/onboarding/bridge.js";
import type {
  ChatGptStatus,
  ClaudeCliStatus,
  CredentialSlotStatus,
} from "../src/onboarding/machine.js";
import {
  createCredentialSettingsController,
  type CredentialSettingsState,
  type CredentialSettingsView,
} from "../src/settings/credential-controller.js";

function runtime(
  llm: RuntimeConfigSnapshot["llm"] = {
    provider: "anthropic",
    model: "synthetic-model",
    credential_configured: true,
  },
  intervals: RuntimeConfigSnapshot["intervals"] = {
    athlete_id: "synthetic-athlete",
    credential_configured: true,
    managedByEnvironment: { athleteId: false },
  },
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm,
    intervals,
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function fakeView() {
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onRequestDelete: (credential: DesktopCredentialId) => void;
        readonly onRequestReset: () => void;
        readonly onCancelDelete: () => void;
        readonly onConfirmDelete: () => void;
        readonly onSetupOpened: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const view: CredentialSettingsView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    retry: () => handlers?.onRetry(),
    requestDelete: (credential: DesktopCredentialId) => handlers?.onRequestDelete(credential),
    requestReset: () => handlers?.onRequestReset(),
    cancelDelete: () => handlers?.onCancelDelete(),
    confirmDelete: () => handlers?.onConfirmDelete(),
    setupOpened: () => handlers?.onSetupOpened(),
    openSetup: () => handlers?.onOpenSetup(),
  };
}

function createSubject(input: {
  readonly runtime?: RuntimeConfigSnapshot;
  readonly statuses?: readonly CredentialSlotStatus[];
  readonly chatGpt?: ChatGptStatus;
  readonly deletion?: CredentialDeleteResult;
  readonly deleteCredential?: (input: {
    readonly credential: DesktopCredentialId;
  }) => Promise<CredentialDeleteResult>;
  readonly openSetup?: () => void;
  readonly claudeCli?: () => Promise<ClaudeCliStatus>;
  readonly onDeleted?: () => Promise<void> | void;
  readonly onReconciled?: () => Promise<void> | void;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly recovery?: CredentialRecoveryStatus;
  readonly loadRecoveryStatus?: () => Promise<CredentialRecoveryStatus>;
  readonly retryRecovery?: () => Promise<CredentialRecoveryStatus>;
  readonly reset?: () => Promise<CredentialResetResult>;
}) {
  let activeRuntime = input.runtime ?? runtime();
  let statuses =
    input.statuses ??
    ([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ] satisfies readonly CredentialSlotStatus[]);
  let chatGpt = input.chatGpt ?? { state: "configured", runtimeReady: false };
  let recovery: CredentialRecoveryStatus =
    input.recovery ?? ({ state: "ready", unverifiedEnvelopes: 0 } as const);
  const subject = fakeView();
  const client = {
    call: vi.fn(async () => activeRuntime),
  };
  const clients = {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
  } as unknown as DesktopCoachClientProvider;
  const deleteCredential = vi.fn(async ({ credential }: { credential: DesktopCredentialId }) => {
    if (input.deleteCredential !== undefined) {
      return input.deleteCredential({ credential });
    }
    const result =
      input.deletion ??
      ({
        credential,
        status: "deleted",
        cleanupPending: false,
      } satisfies CredentialDeleteResult);
    if (result.status === "deleted") {
      statuses = statuses.filter((status) => status.slot !== credential);
      if (credential === activeRuntime.llm.provider) {
        activeRuntime = runtime(
          { ...activeRuntime.llm, credential_configured: false },
          activeRuntime.intervals,
        );
      }
      if (credential === "intervals-icu") {
        activeRuntime = runtime(activeRuntime.llm, {
          ...activeRuntime.intervals,
          credential_configured: false,
        });
      }
    }
    return result;
  });
  const resetAllCredentials = vi.fn(async () => {
    const result =
      (await input.reset?.()) ?? ({ status: "reset", keyCleanupPending: false } as const);
    if (result.status === "reset") {
      statuses = [];
      chatGpt = { state: "absent", runtimeReady: false };
      recovery = { state: "ready", unverifiedEnvelopes: 0 };
      activeRuntime = runtime(
        { ...activeRuntime.llm, credential_configured: false },
        { ...activeRuntime.intervals, credential_configured: false },
      );
    }
    return result;
  });
  const controller = createCredentialSettingsController({
    clients,
    loadStatuses: async () => statuses,
    loadChatGptStatus: async () => chatGpt,
    loadRecoveryStatus: async () => (await input.loadRecoveryStatus?.()) ?? recovery,
    retryCredentialRecovery: async () => {
      recovery = (await input.retryRecovery?.()) ?? recovery;
      return recovery;
    },
    resetAllCredentials,
    ...(input.claudeCli === undefined ? {} : { loadClaudeCliStatus: input.claudeCli }),
    deleteCredential,
    openSetup: input.openSetup ?? vi.fn(),
    ...(input.onDeleted === undefined ? {} : { onDeleted: input.onDeleted }),
    ...(input.onReconciled === undefined ? {} : { onReconciled: input.onReconciled }),
    ...(input.credentialMutationsBlocked === undefined
      ? {}
      : { credentialMutationsBlocked: input.credentialMutationsBlocked }),
    beginMutation: () => vi.fn(),
    view: subject.view,
  });
  return { controller, subject, deleteCredential, resetAllCredentials };
}

function content(state: CredentialSettingsState) {
  if (
    state.status === "ready" ||
    state.status === "confirming" ||
    state.status === "deleting" ||
    state.status === "deleted" ||
    (state.status === "error" && state.kind === "delete")
  ) {
    return state;
  }
  throw new Error(`Expected credential content, received ${state.status}`);
}

describe("credential settings controller", () => {
  it("marks only unverified slots for inline credential re-entry", async () => {
    const { controller } = createSubject({
      recovery: { state: "ready", unverifiedEnvelopes: 1 },
      statuses: [
        { slot: "anthropic", state: "re-prompt", runtimeState: null },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ],
      chatGpt: { state: "absent", runtimeReady: false },
    });

    await controller.activate();

    expect(content(controller.state())).toMatchObject({
      announcement:
        "Enduragent can’t open some saved credentials safely. Enter each affected credential again.",
      recovery: { state: "ready", unverifiedEnvelopes: 1 },
    });
    expect(content(controller.state()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credential: "anthropic", runtimeState: "failed" }),
        expect.objectContaining({ credential: "openrouter", runtimeState: "stored-inactive" }),
      ]),
    );
  });

  it("refreshes the recovery warning when settings reopen", async () => {
    const loadRecoveryStatus = vi
      .fn<() => Promise<CredentialRecoveryStatus>>()
      .mockResolvedValueOnce({ state: "ready", unverifiedEnvelopes: 1 })
      .mockResolvedValue({ state: "ready", unverifiedEnvelopes: 0 });
    const { controller } = createSubject({ loadRecoveryStatus });

    await controller.activate();
    expect(content(controller.state()).recovery).toEqual({
      state: "ready",
      unverifiedEnvelopes: 1,
    });

    controller.close();
    await controller.activate();
    expect(content(controller.state()).recovery).toEqual({
      state: "ready",
      unverifiedEnvelopes: 0,
    });
    expect(content(controller.state()).announcement).toBe("");
    expect(loadRecoveryStatus).toHaveBeenCalledTimes(2);
  });

  it("retries a locked Keychain from the inline recovery message", async () => {
    const retryRecovery = vi.fn(async () => ({ state: "ready", unverifiedEnvelopes: 0 }) as const);
    const { controller, subject } = createSubject({
      recovery: { state: "locked" },
      retryRecovery,
    });
    await controller.activate();

    expect(content(controller.state()).announcement).toBe(
      "Unlock your login Keychain outside Enduragent, then Retry.",
    );
    subject.retry();
    await vi.waitFor(() => expect(retryRecovery).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(content(controller.state()).recovery).toEqual({
        state: "ready",
        unverifiedEnvelopes: 0,
      }),
    );
  });

  it("confirmation-gates the inline missing-key reset and focuses Cancel first", async () => {
    const { controller, subject, resetAllCredentials } = createSubject({
      recovery: { state: "missing" },
    });
    await controller.activate();

    expect(content(controller.state()).announcement).toBe(
      "These credentials cannot be recovered. Remove all credentials and start again.",
    );
    subject.requestReset();
    expect(controller.state()).toMatchObject({
      status: "confirming",
      confirmation: "all",
      focus: { target: "confirmation-cancel" },
    });
    subject.cancelDelete();
    expect(controller.state()).toMatchObject({
      status: "ready",
      confirmation: null,
      announcement: "Credential removal cancelled.",
    });

    subject.requestReset();
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));
    expect(resetAllCredentials).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      entries: [],
      confirmation: null,
      announcement: "All credentials were removed. Set them up again when you’re ready.",
      focus: { target: "setup-open" },
    });
  });

  it("builds a provider, kind, and coarse-state-only list for every stored credential kind", async () => {
    const { controller } = createSubject({});

    await controller.activate();

    expect(content(controller.state()).entries).toEqual([
      {
        credential: "anthropic",
        provider: "Anthropic",
        kind: "Provider API key",
        runtimeState: "active",
      },
      {
        credential: "openai-codex",
        provider: "ChatGPT",
        kind: "ChatGPT profile",
        runtimeState: "stored-inactive",
      },
      {
        credential: "openrouter",
        provider: "OpenRouter",
        kind: "Provider API key",
        runtimeState: "stored-inactive",
      },
      {
        credential: "intervals-icu",
        provider: "intervals.icu",
        kind: "Training account key",
        runtimeState: "active",
      },
    ]);
    const serialized = JSON.stringify(content(controller.state()).entries);
    expect(serialized).not.toContain("synthetic-model");
    expect(serialized).not.toContain("synthetic-athlete");
    expect(serialized).not.toContain("length");
    expect(serialized).not.toContain("hash");
  });

  it("lists the training credential as verifying while owner verification is pending", async () => {
    const pendingIntervals = {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      credential_verification_pending: true,
      managedByEnvironment: { athleteId: false },
    } satisfies RuntimeConfigSnapshot["intervals"];
    const fromStatus = createSubject({
      runtime: runtime(undefined, pendingIntervals),
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }],
    });
    await fromStatus.controller.activate();
    expect(content(fromStatus.controller.state()).entries).toContainEqual({
      credential: "intervals-icu",
      provider: "intervals.icu",
      kind: "Training account key",
      runtimeState: "verifying",
    });

    const fromRuntimeFallback = createSubject({
      runtime: runtime(undefined, pendingIntervals),
      statuses: [],
    });
    await fromRuntimeFallback.controller.activate();
    expect(content(fromRuntimeFallback.controller.state()).entries).toContainEqual({
      credential: "intervals-icu",
      provider: "intervals.icu",
      kind: "Training account key",
      runtimeState: "verifying",
    });
  });

  it("lists a keyless provider as a non-credential status row and never as a credential", async () => {
    const { controller } = createSubject({
      runtime: runtime({
        provider: "claude-cli",
        model: "sonnet",
        credential_configured: true,
      }),
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      claudeCli: async () => ({ state: "ready", email: "athlete@example.test", plan: "Max" }),
    });

    await controller.activate();

    expect(content(controller.state()).providerStatuses).toEqual([
      {
        provider: "claude-cli",
        label: "Claude subscription",
        kind: "Claude Code CLI",
        state: "ready",
        identity: "Signed in as athlete@example.test - Claude Max subscription",
      },
    ]);
    expect(content(controller.state()).entries.map((entry) => entry.credential)).not.toContain(
      "claude-cli",
    );
  });

  it("shows api-key billing on the status row instead of a subscription claim", async () => {
    const { controller } = createSubject({
      runtime: runtime({ provider: "claude-cli", model: "sonnet", credential_configured: true }),
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      claudeCli: async () => ({ state: "ready-api-key" }),
    });

    await controller.activate();

    expect(content(controller.state()).providerStatuses[0]?.identity).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );
  });

  it("explains a turned-off lane and a failed probe without inventing an identity", async () => {
    const disabled = createSubject({
      runtime: runtime({ provider: "claude-cli", model: "sonnet", credential_configured: true }),
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      claudeCli: async () => ({ state: "disabled" }),
    });
    await disabled.controller.activate();
    expect(content(disabled.controller.state()).providerStatuses[0]).toEqual({
      provider: "claude-cli",
      label: "Claude subscription",
      kind: "Claude Code CLI",
      state: "disabled",
      identity: "The Claude subscription lane is turned off on this Mac. Choose another provider.",
    });

    const unavailable = createSubject({
      runtime: runtime({ provider: "claude-cli", model: "sonnet", credential_configured: true }),
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      claudeCli: async () => {
        throw new Error("probe unavailable");
      },
    });
    await unavailable.controller.activate();
    const row = content(unavailable.controller.state()).providerStatuses[0];
    expect(row?.state).toBeNull();
    expect(row?.identity).toBe("Checking the Claude Code CLI sign-in on this Mac…");
  });

  it("emits no status rows and never probes Claude while Codex is active", async () => {
    const claudeCli = vi.fn(async () => ({ state: "ready" }) as ClaudeCliStatus);
    const { controller } = createSubject({
      runtime: runtime({
        provider: "openai-codex",
        model: "gpt-5.2-codex",
        credential_configured: true,
      }),
      claudeCli,
    });

    await controller.activate();

    expect(content(controller.state()).providerStatuses).toEqual([]);
    expect(claudeCli).not.toHaveBeenCalled();
  });

  it("loads a closed controller before confirming an Intervals deletion from Chat", async () => {
    const { controller, subject } = createSubject({});

    subject.requestDelete("intervals-icu");

    await vi.waitFor(() => expect(controller.state().status).toBe("confirming"));
    expect(controller.state()).toMatchObject({
      confirmation: "intervals-icu",
      focus: { target: "confirmation-cancel" },
    });
  });

  it("confirmation-gates active deletion, announces the cutover, and exposes Setup recovery", async () => {
    const openSetup = vi.fn();
    const { controller, subject, deleteCredential } = createSubject({ openSetup });
    await controller.activate();

    subject.requestDelete("anthropic");
    expect(controller.state()).toMatchObject({
      status: "confirming",
      confirmation: "anthropic",
      focus: { target: "confirmation-cancel" },
    });
    subject.cancelDelete();
    expect(controller.state()).toMatchObject({
      status: "ready",
      confirmation: null,
      announcement: "Credential deletion cancelled.",
      focus: { target: "delete", credential: "anthropic" },
    });

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));

    expect(deleteCredential).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: "deleted",
      announcement: "Credential deleted locally.",
      recoveryAvailable: true,
      focus: { target: "setup", credential: "anthropic" },
    });
    subject.openSetup();
    expect(openSetup).toHaveBeenCalledOnce();
    expect(controller.state()).toEqual({ status: "closed" });
  });

  it("requests the open first-time Intervals panel after deletion and clears the request once handled", async () => {
    const onDeleted = vi.fn(async () => {});
    const { controller, subject } = createSubject({ onDeleted });
    await controller.activate();

    subject.requestDelete("intervals-icu");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));

    expect(onDeleted).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: "deleted",
      entries: expect.not.arrayContaining([
        expect.objectContaining({ credential: "intervals-icu" }),
      ]),
      recoveryAvailable: true,
      focus: { target: "setup-open" },
    });

    subject.setupOpened();
    expect(controller.state()).toMatchObject({
      status: "deleted",
      focus: null,
    });
  });

  it("keeps an externally managed credential listed and announces the fixed refusal", async () => {
    const { controller, subject } = createSubject({
      statuses: [],
      chatGpt: { state: "absent", runtimeReady: false },
      deletion: {
        credential: "anthropic",
        status: "refused",
        reason: "managed-by-environment",
      },
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "managed-by-environment",
      confirmation: null,
      announcement: "This credential is managed outside Settings and can’t be deleted here.",
      focus: { target: "delete", credential: "anthropic" },
    });
  });

  it("requires authoritative repair when saved and active runtime state diverge", async () => {
    const onReconciled = vi.fn(async () => {});
    const { controller, subject } = createSubject({
      deletion: {
        credential: "anthropic",
        status: "refused",
        reason: "runtime-state-diverged",
      },
      onReconciled,
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "runtime-state-diverged",
      repairCredential: "anthropic",
      recoveryAvailable: true,
      focus: { target: "feedback" },
    });

    subject.retry();
    await vi.waitFor(() => expect(onReconciled).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(content(controller.state()).repairCredential).toBeNull();
  });

  it("reports deletion uncertainty neutrally and requires repair before another action", async () => {
    const { controller, subject, deleteCredential } = createSubject({
      deletion: {
        slot: "anthropic",
        status: "uncertain",
        reason: "storage-uncertain",
      },
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "storage-uncertain",
      confirmation: null,
      repairCredential: "anthropic",
      announcement:
        "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
      focus: { target: "feedback" },
    });
    const announcement = content(controller.state()).announcement.toLowerCase();
    expect(announcement).not.toContain("credential deleted");
    expect(announcement).not.toContain("remains stored");
    expect(announcement).not.toContain("was not deleted");

    const repairState = controller.state();
    subject.requestDelete("anthropic");
    expect(controller.state()).toBe(repairState);
    subject.requestDelete("openrouter");
    expect(controller.state()).toBe(repairState);
    expect(deleteCredential).toHaveBeenCalledOnce();

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(content(controller.state()).repairCredential).toBeNull();
  });

  it("allows confirmed removal of all credentials while a per-slot deletion needs repair", async () => {
    const { controller, subject, resetAllCredentials } = createSubject({
      deletion: {
        slot: "anthropic",
        status: "uncertain",
        reason: "storage-uncertain",
      },
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() =>
      expect(controller.state()).toMatchObject({
        status: "error",
        repairCredential: "anthropic",
      }),
    );

    subject.requestReset();
    expect(controller.state()).toMatchObject({
      status: "confirming",
      confirmation: "all",
      repairCredential: "anthropic",
    });
    subject.confirmDelete();

    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));
    expect(resetAllCredentials).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: "deleted",
      entries: [],
      confirmation: null,
      repairCredential: null,
    });
  });

  it("treats a rejected delete request as an unknown outcome that requires repair", async () => {
    const { controller, subject, deleteCredential } = createSubject({
      deleteCredential: async () => {
        throw new Error("synthetic bridge rejection");
      },
    });
    await controller.activate();

    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(deleteCredential).toHaveBeenCalledOnce();
    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "storage-uncertain",
      confirmation: null,
      repairCredential: "anthropic",
      announcement:
        "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
      focus: { target: "feedback" },
    });

    const repairState = controller.state();
    subject.requestDelete("openrouter");
    expect(controller.state()).toBe(repairState);
  });

  it("awaits authoritative reconciliation before clearing a repair lock", async () => {
    let resolveReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => {
      resolveReconciliation = resolve;
    });
    const onReconciled = vi.fn(() => reconciliation);
    const { controller, subject } = createSubject({
      deletion: {
        slot: "anthropic",
        status: "uncertain",
        reason: "storage-uncertain",
      },
      onReconciled,
    });
    await controller.activate();
    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    subject.retry();
    await vi.waitFor(() => expect(onReconciled).toHaveBeenCalledOnce());
    expect(controller.state()).toMatchObject({
      status: "loading",
      repairCredential: "anthropic",
    });

    resolveReconciliation();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(content(controller.state()).repairCredential).toBeNull();
  });

  it("retains the repair lock when authoritative reconciliation fails", async () => {
    const onReconciled = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("synthetic readiness refresh failure"))
      .mockResolvedValueOnce();
    const { controller, subject } = createSubject({
      deletion: {
        slot: "anthropic",
        status: "uncertain",
        reason: "storage-uncertain",
      },
      onReconciled,
    });
    await controller.activate();
    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    subject.retry();
    await vi.waitFor(() => expect(onReconciled).toHaveBeenCalledOnce());
    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "load",
      repairCredential: "anthropic",
      focus: { target: "feedback" },
    });

    subject.retry();
    await vi.waitFor(() => expect(onReconciled).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(content(controller.state()).repairCredential).toBeNull();
  });

  it("blocks deletion entry and confirmation while onboarding owns a credential mutation", async () => {
    let onboardingMutating = true;
    const { controller, subject, deleteCredential } = createSubject({
      credentialMutationsBlocked: () => onboardingMutating,
    });
    await controller.activate();

    const ready = controller.state();
    subject.requestDelete("openrouter");
    expect(controller.state()).toBe(ready);

    onboardingMutating = false;
    subject.requestDelete("openrouter");
    expect(controller.state().status).toBe("confirming");

    onboardingMutating = true;
    subject.confirmDelete();
    expect(controller.state().status).toBe("confirming");
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "refused",
      deletion: {
        credential: "anthropic",
        status: "refused",
        reason: "storage-failed",
      } as const,
    },
    {
      name: "uncertain",
      deletion: {
        slot: "anthropic",
        status: "uncertain",
        reason: "storage-uncertain",
      } as const,
    },
  ])("refreshes setup only after confirmed deletion, not $name outcomes", async ({ deletion }) => {
    const onDeleted = vi.fn(async () => {});
    const { controller, subject } = createSubject({ deletion, onDeleted });
    await controller.activate();
    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("refreshes setup after a confirmed deletion", async () => {
    const onDeleted = vi.fn(async () => {});
    const { controller, subject } = createSubject({ onDeleted });
    await controller.activate();
    subject.requestDelete("anthropic");
    subject.confirmDelete();
    await vi.waitFor(() => expect(controller.state().status).toBe("deleted"));
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});

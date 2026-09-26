import {
  CoachClientDisconnectedError,
  connectCoachClientConnection,
  type CoachClient,
  type CoachClientConnection,
  type CoachClientTerminalCause,
} from "@enduragent/coach-client";
import { validateRendererDaemonConnection } from "./daemon-connection";

export type DesktopCoachClient = Pick<CoachClient, "handshake" | "call">;

export interface DesktopCoachClientProvider {
  getClient(): Promise<DesktopCoachClient>;
  reconnect(failedClient?: DesktopCoachClient): Promise<DesktopCoachClient>;
  close(): Promise<void>;
}

interface DesktopConnectionBridge {
  getDaemonConnection(failedGeneration?: number): Promise<unknown>;
}

interface OwnedClient {
  readonly client: DesktopCoachClient;
  readonly connection: CoachClientConnection;
  readonly generation: number;
}

interface ConnectionAttempt {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

export function createDesktopCoachClientProvider(
  connect: typeof connectCoachClientConnection = connectCoachClientConnection,
): DesktopCoachClientProvider {
  let selected: OwnedClient | undefined;
  let connection: Promise<OwnedClient> | undefined;
  let reconnection: Promise<OwnedClient> | undefined;
  let closing: Promise<void> | undefined;
  let shutdownCause: CoachClientDisconnectedError | undefined;
  let failedGeneration: number | undefined;
  const owned = new Set<CoachClientConnection>();
  const retirements = new Map<CoachClientConnection, Promise<void>>();
  const attempts = new Set<ConnectionAttempt>();

  const auth = (): DesktopConnectionBridge =>
    (
      window as unknown as Window & {
        readonly enduragentAuth: DesktopConnectionBridge;
      }
    ).enduragentAuth;

  const retire = (owner: OwnedClient): Promise<void> => {
    const existing = retirements.get(owner.connection);
    if (existing !== undefined) return existing;
    let requested: Promise<void>;
    try {
      requested = owner.connection.closeWhenIdle();
    } catch (error) {
      requested = Promise.reject(error);
    }
    const retirement = requested
      .then(
        () => undefined,
        () => owner.connection.close(),
      )
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        retirements.delete(owner.connection);
        owned.delete(owner.connection);
      });
    retirements.set(owner.connection, retirement);
    return retirement;
  };

  const connectFresh = (recoveryGeneration = failedGeneration): Promise<OwnedClient> => {
    if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
    if (selected !== undefined) return Promise.resolve(selected);
    if (connection !== undefined) return connection;
    let connectingOwner: OwnedClient | undefined;
    let activeAttempt: ConnectionAttempt | undefined;
    let terminalDuringConnect:
      | { readonly client: CoachClient; readonly cause: CoachClientTerminalCause }
      | undefined;
    let connectionGeneration: number | undefined;
    const onTerminal = (failedClient: CoachClient, cause: CoachClientTerminalCause): void => {
      if (connectingOwner === undefined) {
        terminalDuringConnect = { client: failedClient, cause };
        return;
      }
      if (failedClient !== connectingOwner.client || selected !== connectingOwner) return;
      selected = undefined;
      failedGeneration = connectingOwner.generation;
      void retire(connectingOwner);
    };
    const pending = auth()
      .getDaemonConnection(recoveryGeneration)
      .then(validateRendererDaemonConnection)
      .then((options) => {
        if (shutdownCause !== undefined) throw shutdownCause;
        connectionGeneration = options.generation;
        const controller = new AbortController();
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        activeAttempt = { controller, settled, settle };
        attempts.add(activeAttempt);
        return connect({
          url: options.url,
          token: options.rendererCapability,
          signal: controller.signal,
          onTerminal,
        });
      })
      .then(async (connected) => {
        owned.add(connected);
        const owner: OwnedClient = {
          client: connected.client,
          connection: connected,
          generation: connectionGeneration!,
        };
        connectingOwner = owner;
        if (terminalDuringConnect?.client === owner.client) {
          failedGeneration = owner.generation;
          void retire(owner);
          throw terminalDuringConnect.cause;
        }
        if (shutdownCause !== undefined) {
          await connected.close();
          owned.delete(connected);
          throw shutdownCause;
        }
        selected = owner;
        failedGeneration = undefined;
        return owner;
      })
      .catch((error: unknown) => {
        if (shutdownCause !== undefined) throw shutdownCause;
        failedGeneration = connectionGeneration;
        throw error;
      })
      .finally(() => {
        if (activeAttempt !== undefined) {
          activeAttempt.settle();
          attempts.delete(activeAttempt);
        }
        if (connection === pending) connection = undefined;
      });
    connection = pending;
    return pending;
  };

  const alreadyReplaced = (
    owner: OwnedClient,
    failedClient: DesktopCoachClient | undefined,
  ): boolean => failedClient !== undefined && owner.client !== failedClient;

  const reconnect = (failedClient: DesktopCoachClient | undefined): Promise<OwnedClient> => {
    if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
    if (selected !== undefined && alreadyReplaced(selected, failedClient)) {
      return Promise.resolve(selected);
    }
    if (reconnection !== undefined) return reconnection;
    let pending!: Promise<OwnedClient>;
    pending = (async () => {
      let previous = selected;
      const previousConnection = connection;
      if (previous === undefined && previousConnection !== undefined) {
        previous = await previousConnection.then(
          (owner) => owner,
          () => undefined,
        );
      }
      if (previous !== undefined && alreadyReplaced(previous, failedClient)) return previous;
      if (selected === previous) selected = undefined;
      if (previous !== undefined) void retire(previous);
      return connectFresh(previous?.generation ?? failedGeneration);
    })().finally(() => {
      if (reconnection === pending) reconnection = undefined;
    });
    reconnection = pending;
    return pending;
  };

  return {
    getClient() {
      if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
      const available = reconnection ?? (selected === undefined ? connectFresh() : undefined);
      return available === undefined
        ? Promise.resolve(selected!.client)
        : available.then((owner) => owner.client);
    },
    reconnect(failedClient) {
      return reconnect(failedClient).then((owner) => owner.client);
    },
    close() {
      if (closing !== undefined) return closing;
      shutdownCause = new CoachClientDisconnectedError(1000, "");
      selected = undefined;
      connection = undefined;
      reconnection = undefined;
      const known = [...owned];
      const activeAttempts = [...attempts];
      for (const attempt of activeAttempts) attempt.controller.abort();
      closing = Promise.allSettled([
        ...known.map((entry) => entry.close()),
        ...activeAttempts.map((attempt) => attempt.settled),
      ]).then(() => {
        for (const entry of known) {
          owned.delete(entry);
          retirements.delete(entry);
        }
      });
      return closing;
    },
  };
}

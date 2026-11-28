import { CoachClientDisconnectedError } from "@enduragent/coach-client";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";
import type { IntervalsSignInHealth } from "../intervals-sign-in-health";
import { validateImportPaths, type OnboardingBridge } from "./bridge";
import { openRouterSignInBridge } from "./openrouter-sign-in";

export function createClientOnboardingBridge(
  clients: DesktopCoachClientProvider,
  signInHealth: Pick<IntervalsSignInHealth, "signedIn">,
): OnboardingBridge {
  let onboardingNeedsReconnect = false;
  let onboardingFailedClient: DesktopCoachClient | undefined;
  const onboardingClient = async () => {
    const client = onboardingNeedsReconnect
      ? await clients.reconnect(onboardingFailedClient)
      : await clients.getClient();
    onboardingNeedsReconnect = false;
    onboardingFailedClient = undefined;
    return client;
  };
  const onboardingBridge: OnboardingBridge = {
    async getSetupStatus() {
      const client = await onboardingClient();
      return client.call("getSetupStatus", {});
    },
    credentialStatuses: () => window.enduragentAuth.credentialStatuses(),
    retryFailedCredentials: () => window.enduragentAuth.retryFailedCredentials(),
    writeCredential: (value) => window.enduragentAuth.writeCredential(value),
    signInWithIntervals: () => signInHealth.signedIn(window.enduragentAuth.signInWithIntervals()),
    cancelIntervalsSignIn: () => window.enduragentAuth.cancelIntervalsSignIn(),
    reopenIntervalsSignIn: () => window.enduragentAuth.reopenIntervalsSignIn(),
    onIntervalsSignInProgress: (listener) =>
      window.enduragentAuth.onIntervalsSignInProgress(listener),
    ...openRouterSignInBridge(window.enduragentAuth),
    llmConfiguration: () => window.enduragentAuth.llmConfiguration(),
    applyLlmSelection: (value) => window.enduragentAuth.applyLlmSelection(value),
    chatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    chatGptLogin: (value) => window.enduragentAuth.chatgptLogin(value),
    cancelChatGptLogin: (operationId) => window.enduragentAuth.cancelChatgptLogin(operationId),
    onChatGptLoginProgress: (listener) => window.enduragentAuth.onChatgptLoginProgress(listener),
    claudeCliStatus: () => window.enduragentAuth.claudeCliStatus(),
    claudeCliRecheck: () => window.enduragentAuth.claudeCliRecheck(),
    chooseImportFiles: () => window.enduragentAuth.chooseImportFiles(),
    onDroppedImportFiles: (listener) => window.enduragentAuth.onDroppedImportFiles(listener),
    async importFiles(paths, onProgress) {
      let client: DesktopCoachClient | undefined;
      try {
        client = await onboardingClient();
        return await client.call(
          "importFiles",
          { paths: [...validateImportPaths(paths)] },
          { onNotificationEnvelope: onProgress },
        );
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) {
          onboardingNeedsReconnect = true;
          onboardingFailedClient = client;
        }
        throw error;
      }
    },
  };
  return onboardingBridge;
}

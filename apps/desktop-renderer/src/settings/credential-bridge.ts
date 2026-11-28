export function credentialSettingsBridge(auth: EnduragentAuth) {
  return {
    loadStatuses: () => auth.credentialStatuses(),
    loadChatGptStatus: () => auth.chatgptStatus(),
    loadRecoveryStatus: () => auth.credentialRecoveryStatus(),
    retryCredentialRecovery: () => auth.retryCredentialRecovery(),
    retryFailedCredentials: () => auth.retryFailedCredentials(),
    resetAllCredentials: () => auth.resetAllCredentials(),
    loadClaudeCliStatus: () => auth.claudeCliStatus(),
    deleteCredential: (value: Parameters<EnduragentAuth["deleteCredential"]>[0]) =>
      auth.deleteCredential(value),
  };
}

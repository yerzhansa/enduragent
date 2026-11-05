export const TYPING_HEARTBEAT_MS = 4_000;

export function startTypingHeartbeat(
  pulse: () => Promise<unknown>,
  intervalMs: number,
  onError: (err: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let handlerFailure: { readonly error: unknown } | undefined;
  const beat = () => {
    if (inFlight !== undefined) return;
    const reported = Promise.resolve()
      .then(pulse)
      .then(() => undefined, onError);
    const task = Promise.allSettled([reported])
      .then(([outcome]) => {
        if (outcome?.status === "rejected") handlerFailure ??= { error: outcome.reason };
      })
      .finally(() => {
        if (inFlight === task) inFlight = undefined;
      });
    inFlight = task;
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await inFlight;
    if (handlerFailure !== undefined) throw handlerFailure.error;
  };
}

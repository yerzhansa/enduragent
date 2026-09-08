const locks = new Map<string, Promise<void>>();

export async function withSessionLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(chatId, next.then(() => {}, () => {}));
  return next;
}

export function drainSessionLocks(): Promise<void> {
  return Promise.all(locks.values()).then(() => {});
}

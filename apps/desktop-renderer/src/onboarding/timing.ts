export type BoundedResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected" };

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<BoundedResult<T>, BoundedResult<T>>(
        (value) => ({ status: "fulfilled", value }),
        () => ({ status: "rejected" }),
      ),
      new Promise<BoundedResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "rejected" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function afterNextPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let secondFrame: number | undefined;
  let cancelled = false;
  const firstFrame = requestAnimationFrame(() => {
    if (cancelled) return;
    secondFrame = requestAnimationFrame(() => {
      if (!cancelled) callback();
    });
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
  };
}

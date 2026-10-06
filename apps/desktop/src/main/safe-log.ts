export function createSafeLog(
  log?: (message: string) => void,
): (message: string) => void {
  const outputLog =
    log ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });
  return (message: string): void => {
    try {
      outputLog(message);
    } catch {}
  };
}

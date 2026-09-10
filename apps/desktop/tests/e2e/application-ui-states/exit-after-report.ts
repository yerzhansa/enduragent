import type { FullResult, Reporter } from "@playwright/test/reporter";

export default class ExitAfterReport implements Reporter {
  onEnd(result: FullResult): void {
    const code = result.status === "passed" ? 0 : 1;
    setTimeout(() => {
      process.exit(code);
    }, 1_000);
  }
}

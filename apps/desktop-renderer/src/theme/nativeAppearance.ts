import type { Appearance } from "@enduragent/ui";

export function publishNativeAppearance(appearance: Appearance): void {
  try {
    const bridge = (globalThis as { window?: Partial<Window> }).window?.enduragentAuth;
    bridge?.setAppearance(appearance);
  } catch {
    return;
  }
}

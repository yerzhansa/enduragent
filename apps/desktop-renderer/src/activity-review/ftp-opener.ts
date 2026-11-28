let opener: HTMLElement | null = null;

export function registerFtpOpener(element: HTMLElement | null): void {
  if (element !== null || opener?.isConnected !== true) opener = element;
}

export function focusFtpOpener(): void {
  opener?.focus();
}

import type { TranscriptHydrationChange } from "../chat/hydration";

export const CHAT_FOLLOW_LATEST_THRESHOLD = 80;
export const CHAT_AUTO_LOAD_EARLIER_THRESHOLD = 32;

export interface ChatStreamBuffer {
  set(messageId: string, text: string): void;
  append(messageId: string, delta: string): void;
  attach(messageId: string, host: HTMLElement | null): void;
  retain(messageIds: ReadonlySet<string>): void;
  read(messageId: string): string;
  clear(): void;
}

interface StreamEntry {
  text: string;
  node: Text | null;
  host: HTMLElement | null;
}

export function createChatStreamBuffer(): ChatStreamBuffer {
  const entries = new Map<string, StreamEntry>();
  const entry = (messageId: string): StreamEntry => {
    const existing = entries.get(messageId);
    if (existing !== undefined) return existing;
    const created: StreamEntry = { text: "", node: null, host: null };
    entries.set(messageId, created);
    return created;
  };
  const paint = (target: StreamEntry): void => {
    const host = target.host;
    if (host === null) {
      target.node = null;
      return;
    }
    const node = host.ownerDocument.createTextNode(target.text);
    host.replaceChildren(node);
    target.node = node;
  };

  return {
    set(messageId, text) {
      const target = entry(messageId);
      if (target.text === text && (target.host === null) === (target.node === null)) return;
      target.text = text;
      paint(target);
    },
    append(messageId, delta) {
      const target = entry(messageId);
      target.text += delta;
      target.node?.appendData(delta);
    },
    attach(messageId, host) {
      if (host === null) {
        const existing = entries.get(messageId);
        if (existing !== undefined) {
          existing.host = null;
          existing.node = null;
        }
        return;
      }
      const target = entry(messageId);
      target.host = host;
      paint(target);
    },
    retain(messageIds) {
      for (const messageId of entries.keys()) {
        if (!messageIds.has(messageId)) entries.delete(messageId);
      }
    },
    read(messageId) {
      return entries.get(messageId)?.text ?? "";
    },
    clear() {
      entries.clear();
    },
  };
}

export interface ChatScrollApply {
  readonly hydrationChanged: boolean;
  readonly hydrationChange: TranscriptHydrationChange;
}

export const CHAT_ANCHOR_ROW_SELECTOR = ".chat-message";

export interface ChatScrollAnchor {
  attach(element: HTMLElement | null): void;
  capture(): void;
  apply(input: ChatScrollApply): void;
  reanchor(): void;
}

interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly row: HTMLElement | null;
  readonly rowTop: number;
}

export function createChatScrollAnchor(): ChatScrollAnchor {
  let host: HTMLElement | null = null;
  let captured: ScrollMetrics | null = null;
  let initialPending = false;

  return {
    attach(element) {
      host = element;
      captured = null;
      initialPending = element !== null;
    },
    capture() {
      if (host === null) {
        captured = null;
        return;
      }
      const candidate = host.querySelector(CHAT_ANCHOR_ROW_SELECTOR);
      const row = candidate instanceof HTMLElement ? candidate : null;
      captured = {
        scrollTop: host.scrollTop,
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        row,
        rowTop: row === null ? 0 : row.getBoundingClientRect().top,
      };
    },
    apply(input) {
      const metrics = captured;
      captured = null;
      if (host === null) return;
      if (metrics === null) return;
      if (input.hydrationChanged && input.hydrationChange === "initial") {
        host.scrollTop = host.scrollHeight;
        initialPending = host.clientHeight === 0 && host.scrollHeight === 0;
        return;
      }
      if (host.isConnected && host.clientHeight === 0 && host.scrollHeight === 0) return;
      if (input.hydrationChanged && input.hydrationChange === "prepend") {
        const row = metrics.row;
        host.scrollTop =
          row !== null && row.isConnected
            ? metrics.scrollTop + (row.getBoundingClientRect().top - metrics.rowTop)
            : metrics.scrollTop + Math.max(0, host.scrollHeight - metrics.scrollHeight);
        return;
      }
      const followsLatest =
        metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <=
        CHAT_FOLLOW_LATEST_THRESHOLD;
      if (followsLatest) host.scrollTop = host.scrollHeight;
    },
    reanchor() {
      if (host === null || !initialPending || host.scrollHeight === 0) return;
      host.scrollTop = host.scrollHeight;
      initialPending = false;
    },
  };
}

export const chatStreamBuffer = createChatStreamBuffer();
export const chatScrollAnchor = createChatScrollAnchor();

export function resetChatStream(): void {
  chatStreamBuffer.clear();
  chatScrollAnchor.attach(null);
}

import { useLayoutEffect, useRef, type ReactElement } from "react";
import { renderCoachMarkdown } from "../../chat/markdown";
import { MessageContent } from "@enduragent/ui";
import type { WireMessage } from "../../chat/message-state";
import { useWireMessageText } from "./use-wire-message-text";

export function CoachMessage(props: {
  readonly text: string;
  readonly message?: WireMessage;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const text = useWireMessageText(props.text, props.message);

  useLayoutEffect(() => {
    const node = host.current;
    if (node === null) return;
    renderCoachMarkdown(node, text);
  }, [text]);

  return <MessageContent ref={host} />;
}

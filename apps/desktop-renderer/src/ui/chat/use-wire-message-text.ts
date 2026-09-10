import { useEffect, useState } from "react";
import type { Message } from "@enduragent/i18n";
import { messageFromWire } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { WireMessage } from "../../chat/message-state";

export function useWireMessageText(text: string, descriptor?: WireMessage): string {
  const { say } = usePhrasebook();
  const [validated, setValidated] = useState<{
    readonly descriptor: WireMessage;
    readonly message: Message;
  }>();

  useEffect(() => {
    if (descriptor === undefined) return;
    let active = true;
    void messageFromWire(descriptor).then(
      (message) => {
        if (active && message !== undefined) setValidated({ descriptor, message });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [descriptor]);

  return validated !== undefined && validated.descriptor === descriptor
    ? say(validated.message)
    : text;
}

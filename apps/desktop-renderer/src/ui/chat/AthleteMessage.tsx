import type { ReactElement } from "react";
import { isSlashCommandText } from "../../chat/commands";
import { MessageContent } from "@enduragent/ui";

export function AthleteMessage(props: { readonly text: string }): ReactElement {
  return <MessageContent command={isSlashCommandText(props.text)}>{props.text}</MessageContent>;
}

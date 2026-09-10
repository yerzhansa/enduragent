import { usePhrasebook } from "@enduragent/i18n/react";
import { useLayoutEffect, useRef, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@enduragent/ui";
import { PLATFORM_COPY } from "../../platform-copy";
import { focusNewConversationOpener } from "../../state/new-conversation-opener";
import { useEnduragentStore } from "../../state/store";

export function NewConversationDialog(props: {
  readonly onComposerReset: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const resetCount = useEnduragentStore((state) => state.chat.resetCount);
  const hasHydratedHistory = useEnduragentStore((state) => state.chat.hasHydratedHistory);
  const hasAttachmentDraft = useEnduragentStore((state) => state.chat.attachments?.draft != null);
  const actions = useEnduragentStore((state) => state.chatActions);
  const cancel = useRef<HTMLButtonElement>(null);
  const renderedResetCount = useRef(resetCount);
  const onComposerReset = props.onComposerReset;

  const pending = resetPhase === "resetting";
  const requested = resetPhase === "confirming" || pending;
  const renderedRequested = useRef(requested);

  useLayoutEffect(() => {
    const completed = resetCount !== renderedResetCount.current;
    const wasRequested = renderedRequested.current;
    renderedResetCount.current = resetCount;
    renderedRequested.current = requested;
    if (requested) return;
    if (completed) onComposerReset();
    else if (wasRequested) focusNewConversationOpener();
  }, [onComposerReset, requested, resetCount]);

  return (
    <Dialog
      open={requested}
      onOpenChange={(open) => {
        if (!open && !pending) actions?.cancelNewConversation();
      }}
    >
      <DialogContent
        className="new-conversation-dialog w-[min(460px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
        finalFocus={false}
        aria-busy={pending ? "true" : undefined}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle id="new-conversation-title" className="m-0 text-xl">
            {say("chat.newConversation.title")}
          </DialogTitle>
          <DialogDescription id="new-conversation-description" className="m-0 leading-[1.5]">
            {hasAttachmentDraft
              ? say("chat.newConversation.attachmentDraft")
              : hasHydratedHistory
                ? say("chat.newConversation.hydrated", { computer: PLATFORM_COPY.computer })
                : say("chat.newConversation.base")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="new-conversation-dialog__actions mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={cancel}
                className="new-conversation-dialog__cancel"
                variant="outline"
                size="lg"
                disabled={pending}
              />
            }
          >
            {say("chat.newConversation.cancel")}
          </DialogClose>
          <Button
            className="new-conversation-dialog__confirm"
            size="lg"
            disabled={pending}
            onClick={() => {
              actions?.confirmNewConversation();
            }}
          >
            {say("chat.newConversation.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

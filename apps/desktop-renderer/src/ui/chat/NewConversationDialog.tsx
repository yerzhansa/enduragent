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

const BASE_COPY =
  "Your visible conversation will be cleared. Your training data and saved coach memory will remain.";
const HYDRATED_COPY = `Your visible conversation and the earlier messages restored on ${PLATFORM_COPY.computer} will be cleared. Your training data and saved coach memory will remain.`;
const ATTACHMENT_DRAFT_COPY =
  "Your visible conversation and unsent attachment draft will be cleared. Your training data and saved coach memory will remain.";

export function NewConversationDialog(props: {
  readonly onComposerReset: () => void;
}): ReactElement {
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
            Start a new conversation?
          </DialogTitle>
          <DialogDescription id="new-conversation-description" className="m-0 leading-[1.5]">
            {hasAttachmentDraft
              ? ATTACHMENT_DRAFT_COPY
              : hasHydratedHistory
                ? HYDRATED_COPY
                : BASE_COPY}
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
            Cancel
          </DialogClose>
          <Button
            className="new-conversation-dialog__confirm"
            size="lg"
            disabled={pending}
            onClick={() => {
              actions?.confirmNewConversation();
            }}
          >
            Start new conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

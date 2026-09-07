import { ComposerControls, ComposerInput, ComposerAction } from "@enduragent/ui";
import {
  useImperativeHandle,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Paperclip } from "lucide-react";
import { filterSlashCommands } from "../../chat/commands";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { setupReady } from "../../state/onboarding-slice";
import { SlashPopup } from "./SlashPopup";

export interface ComposerHandle {
  focus(): void;
  reset(): void;
}

export function Composer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
  readonly inputId?: string;
  readonly hidden?: boolean;
  readonly leadingAction?: ReactNode;
  readonly surface?: {
    readonly status: "idle" | "streaming" | "interrupted";
    readonly sendDisabled: boolean;
    readonly inputDisabled: boolean;
    readonly placeholder: string;
    readonly label: string;
    readonly allowSlashCommands?: boolean;
    submit(message: string): Promise<boolean>;
    stop(): void;
  };
}): ReactElement {
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const restoredRevision = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();
  const chatSendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const chatInputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const chatStatus = useEnduragentStore((state) => state.chat.status);
  const actions = useEnduragentStore((state) => state.chatActions);
  const chatReady = useEnduragentStore(setupReady);
  const attachmentSurface = useEnduragentStore((state) => state.chat.attachments);
  const attachmentIds =
    attachmentSurface?.draft?.attachments.map((attachment) => attachment.attachmentId) ?? [];
  const sendDisabled = props.surface?.sendDisabled ?? chatSendDisabled;
  const inputDisabled = props.surface?.inputDisabled ?? chatInputDisabled;
  const status = props.surface?.status ?? chatStatus;
  const canChat = props.surface === undefined ? chatReady : true;
  const inputId = props.inputId ?? "message";

  const matches = useMemo(
    () => (props.surface?.allowSlashCommands === false ? [] : filterSlashCommands(draft)),
    [draft, props.surface?.allowSlashCommands],
  );
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useEffect(() => {
    if (props.surface !== undefined) return;
    const restored = attachmentSurface?.draft;
    if (restored === undefined || restored === null) return;
    const revision = `${restored.updatedAt}:${restored.text}`;
    if (restoredRevision.current === revision) return;
    restoredRevision.current = revision;
    const input = textarea.current;
    if (input === null || input.value === restored.text) return;
    if (input.value.length > 0 && restored.state !== "restored") return;
    input.value = restored.text;
    setDraft(restored.text);
  }, [attachmentSurface, props.surface]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    },
    [],
  );

  useImperativeHandle(
    props.handle,
    () => ({
      focus() {
        textarea.current?.focus();
      },
      reset() {
        if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const input = textarea.current;
        if (input !== null) {
          input.value = "";
          input.focus();
        }
        setDraft("");
        setSelected(0);
        setDismissed(false);
      },
    }),
    [],
  );

  const submit = async (): Promise<void> => {
    const input = textarea.current;
    if (
      input === null ||
      sendDisabled ||
      submitting ||
      !canChat ||
      (props.surface === undefined && actions === null)
    ) {
      return;
    }
    const value = input.value;
    if (!/\S/u.test(value) && (props.surface !== undefined || attachmentIds.length === 0)) return;
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (props.surface === undefined) actions!.saveAttachmentDraftText(value);
    setSubmitting(true);
    try {
      const acknowledged =
        props.surface !== undefined
          ? await props.surface.submit(value)
          : attachmentIds.length === 0
            ? await actions!.submit(value)
            : await actions!.submit(value, attachmentIds);
      if (!acknowledged) return;
      if (input.value === value) {
        input.value = "";
        setDraft("");
        setSelected(0);
        setDismissed(false);
      }
    } catch {
      input.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const accept = (index: number): void => {
    const match = matches[index];
    const input = textarea.current;
    if (match === undefined || input === null) return;
    const inserted = `${match.command} `;
    input.value = inserted;
    setDraft(inserted);
    setSelected(0);
    setDismissed(false);
    input.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((active + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + matches.length - 1) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(active);
        return;
      }
      if (event.key === "Escape") setDismissed(true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
      return;
    }
    event.preventDefault();
    void actions?.pasteAttachment();
  };

  return (
    <form
      ref={form}
      className="composer relative"
      data-chat-attachment-dropzone={
        props.surface === undefined && !inputDisabled && canChat ? "true" : undefined
      }
      hidden={props.hidden}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SlashPopup
        open={open}
        anchor={form}
        listboxId={listboxId}
        matches={matches}
        selected={active}
        onHighlight={setSelected}
        onAccept={accept}
        onDismiss={() => {
          setDismissed(true);
        }}
      />
      <label className="sr-only" htmlFor={inputId}>
        {props.surface?.label ?? "Message your coach"}
      </label>
      <ComposerControls
        actions={
          <>
            {props.leadingAction ??
              (props.surface === undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Attach files"
                  disabled={
                    actions === null || inputDisabled || !canChat || attachmentSurface === null
                  }
                  onClick={() => void actions?.chooseAttachments()}
                >
                  <Paperclip aria-hidden="true" />
                </Button>
              ) : null)}
            {status === "streaming" ? (
              <ComposerAction
                mode="stop"
                disabled={props.surface === undefined && actions === null}
                onClick={() => {
                  if (props.surface === undefined) actions?.stop();
                  else props.surface.stop();
                }}
              />
            ) : (
              <ComposerAction mode="send" disabled={sendDisabled || submitting || !canChat} />
            )}
          </>
        }
      >
        <ComposerInput
          id={inputId}
          ref={textarea}
          rows={2}
          placeholder={
            status === "streaming"
              ? "Coach is responding…"
              : (props.surface?.placeholder ?? "Message your coach")
          }
          disabled={inputDisabled || !canChat}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open ? `${listboxId}-option-${active}` : undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft(value);
            setSelected(0);
            setDismissed(false);
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null;
              if (props.surface === undefined) actions?.saveAttachmentDraftText(value);
            }, 300);
          }}
          onKeyDown={onKeyDown}
          onPaste={props.surface === undefined ? onPaste : undefined}
          onBlur={() => {
            setDismissed(true);
          }}
        />
      </ComposerControls>
    </form>
  );
}

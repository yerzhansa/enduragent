import { chatFeedbackMessage } from "./copy";
import { usePhrasebook } from "@enduragent/i18n/react";
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
import { createDraftSaveTimer } from "../../chat/draft-save-timer";
import { Button } from "@enduragent/ui";
import { planChangePendingCheck, planChangePendingInLibrary } from "../../state/chat-slice";
import { useEnduragentStore } from "../../state/store";
import { setupReady } from "../../state/onboarding-slice";
import { SlashPopup } from "./SlashPopup";

export interface ComposerHandle {
  focus(): void;
  reset(): void;
  replace(text: string): void;
  sending(): string | null;
}

export function Composer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
  readonly draftMemory?: RefObject<string>;
  readonly draftSetAside?: boolean;
  readonly draftSetAsideRef?: RefObject<boolean>;
  readonly planChangeDraftRevision?: number | null;
  readonly onPlanChangeDraftSubmitted?: (revision: number) => string | null;
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
  const { say } = usePhrasebook();
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(props.draftMemory?.current ?? "");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<string | null>(null);
  const restoredRevision = useRef<string | null>(null);
  const latestDraft = useRef(props.draftMemory?.current ?? "");
  const [draftSaveTimer] = useState(createDraftSaveTimer);
  const listboxId = useId();
  const chatSendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const changeCheckDocked = useEnduragentStore(
    (state) => planChangePendingCheck(state.planChange, state.planLibrary.value) !== null,
  );
  const typedPlanChange = useEnduragentStore(
    (state) => state.planChange.textRouting || planChangePendingInLibrary(state.planLibrary.value),
  );
  const chatInputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const chatPlaceholder = useEnduragentStore((state) => state.chat.composerPlaceholder);
  const chatPlaceholderMessage = chatFeedbackMessage(chatPlaceholder);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const chatStatus = useEnduragentStore((state) => state.chat.status);
  const actions = useEnduragentStore((state) => state.chatActions);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const surfaceRef = useRef(props.surface);
  surfaceRef.current = props.surface;
  const draftSetAsidePropRef = useRef(props.draftSetAsideRef);
  draftSetAsidePropRef.current = props.draftSetAsideRef;
  const chatReady = useEnduragentStore(setupReady);
  const attachmentSurface = useEnduragentStore((state) => state.chat.attachments);
  const attachmentIds =
    attachmentSurface?.draft?.attachments.map((attachment) => attachment.attachmentId) ?? [];
  const sendDisabled = props.surface?.sendDisabled ?? (chatSendDisabled || changeCheckDocked);
  const inputDisabled = props.surface?.inputDisabled ?? (chatInputDisabled || changeCheckDocked);
  const status = props.surface?.status ?? chatStatus;
  const canChat = props.surface === undefined ? chatReady : true;
  const inputId = props.inputId ?? "message";
  useEffect(() => {
    if (focusRequest?.target !== "composer" || props.surface !== undefined) return;
    queueMicrotask(() => {
      if (textarea.current?.disabled === false) textarea.current.focus();
    });
  }, [focusRequest?.revision, focusRequest?.target, props.surface]);

  const matches = useMemo(
    () => (props.surface?.allowSlashCommands === false ? [] : filterSlashCommands(draft)),
    [draft, props.surface?.allowSlashCommands],
  );
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useEffect(() => {
    if (props.surface !== undefined || props.draftSetAside === true) return;
    const restored = attachmentSurface?.draft;
    if (restored === undefined || restored === null) return;
    const revision = `${restored.updatedAt}:${restored.text}`;
    if (restoredRevision.current === revision) return;
    restoredRevision.current = revision;
    const input = textarea.current;
    if (input === null || input.value === restored.text) return;
    if (input.value.length > 0 && restored.state !== "restored") return;
    draftSaveTimer.cancel();
    input.value = restored.text;
    latestDraft.current = restored.text;
    if (props.draftMemory !== undefined) props.draftMemory.current = restored.text;
    setDraft(restored.text);
  }, [attachmentSurface, draftSaveTimer, props.draftMemory, props.draftSetAside, props.surface]);

  useEffect(
    () => () => {
      draftSaveTimer.flush();
    },
    [draftSaveTimer],
  );

  useImperativeHandle(
    props.handle,
    () => ({
      focus() {
        textarea.current?.focus();
      },
      reset() {
        draftSaveTimer.cancel();
        const input = textarea.current;
        if (input !== null) {
          input.value = "";
          input.focus();
        }
        latestDraft.current = "";
        if (props.draftMemory !== undefined) props.draftMemory.current = "";
        setDraft("");
        setSelected(0);
        setDismissed(false);
      },
      replace(text: string) {
        draftSaveTimer.cancel();
        const input = textarea.current;
        if (input !== null) input.value = text;
        latestDraft.current = text;
        if (props.draftMemory !== undefined) props.draftMemory.current = text;
        setDraft(text);
        setSelected(0);
        setDismissed(false);
      },
      sending: () => inFlight.current,
    }),
    [draftSaveTimer],
  );

  const persistDraft = (value: string): void => {
    if (
      surfaceRef.current === undefined &&
      draftSetAsidePropRef.current?.current !== true &&
      useEnduragentStore.getState().chat.composerStatus === null
    ) {
      actionsRef.current?.saveAttachmentDraftText(value);
    }
  };

  const recordDraft = (value: string): void => {
    latestDraft.current = value;
    if (props.draftMemory !== undefined) props.draftMemory.current = value;
    setDraft(value);
    setSelected(0);
    setDismissed(false);
    draftSaveTimer.schedule(() => persistDraft(latestDraft.current));
  };

  const submit = async (): Promise<void> => {
    const input = textarea.current;
    const surface = props.surface;
    const send =
      surface !== undefined
        ? (value: string) => surface.submit(value)
        : actions === null
          ? null
          : (value: string) =>
              attachmentIds.length === 0
                ? actions.submit(value)
                : actions.submit(value, attachmentIds);
    if (input === null || send === null || sendDisabled || submitting || !canChat) return;
    const value = input.value;
    if (!/\S/u.test(value) && (surface !== undefined || attachmentIds.length === 0)) return;
    draftSaveTimer.cancel();
    const draftSetAside = props.draftSetAsideRef?.current === true;
    const submittedPlanChangeRevision = props.planChangeDraftRevision ?? null;
    if (surface === undefined && !draftSetAside) actions?.saveAttachmentDraftText(value);
    setSubmitting(true);
    inFlight.current = value;
    try {
      const acknowledged = await send(value);
      if (!acknowledged) return;
      const restored =
        submittedPlanChangeRevision === null
          ? null
          : (props.onPlanChangeDraftSubmitted?.(submittedPlanChangeRevision) ?? null);
      if (input.value === value) {
        const next = restored ?? "";
        input.value = next;
        latestDraft.current = next;
        if (
          props.draftMemory !== undefined &&
          (input === textarea.current || props.draftMemory.current === value)
        ) {
          props.draftMemory.current = next;
        }
        setDraft(next);
        setSelected(0);
        setDismissed(false);
        if (surface === undefined && restored !== null) {
          actions?.saveAttachmentDraftText(restored);
        }
      }
    } catch {
      input.focus();
    } finally {
      inFlight.current = null;
      setSubmitting(false);
    }
  };

  const accept = (index: number): void => {
    const match = matches[index];
    const input = textarea.current;
    if (match === undefined || input === null) return;
    const inserted = `${match.command} `;
    input.value = inserted;
    recordDraft(inserted);
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
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          matches[active]?.command === event.currentTarget.value.trim().toLowerCase()
        ) {
          void submit();
          return;
        }
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
      data-parity="composer"
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
        {props.surface?.label ?? say("chat.composer.label")}
      </label>
      <ComposerControls
        className="gap-1.5 pt-[calc(var(--row-inset)+1px)]"
        actions={
          <>
            {props.leadingAction ??
              (props.surface === undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="gap-inset text-ink-3 disabled:text-ink-3 disabled:opacity-100"
                  aria-label={say("chat.composer.attach")}
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
                aria-label={say("chat.composer.stop")}
                disabled={props.surface === undefined && actions === null}
                onClick={() => {
                  if (props.surface === undefined) actions?.stop();
                  else props.surface.stop();
                }}
              />
            ) : (
              <ComposerAction
                mode="send"
                aria-label={say("chat.composer.send")}
                className="gap-inset border-0 px-1.5 py-px text-base leading-6 disabled:bg-sunk disabled:text-ink-3 disabled:opacity-100"
                disabled={sendDisabled || submitting || !canChat}
              />
            )}
          </>
        }
      >
        <ComposerInput
          id={inputId}
          ref={textarea}
          data-parity="composer.textarea"
          defaultValue={props.draftMemory?.current ?? ""}
          rows={1}
          maxLength={props.surface === undefined && typedPlanChange ? 2000 : undefined}
          className="pb-1.5"
          placeholder={
            status === "streaming"
              ? say("chat.composer.responding")
              : (props.surface?.placeholder ??
                (chatPlaceholderMessage === null ? chatPlaceholder : say(chatPlaceholderMessage)))
          }
          disabled={inputDisabled || !canChat}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open ? `${listboxId}-option-${active}` : undefined}
          onChange={(event) => {
            recordDraft(event.currentTarget.value);
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

import {
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { filterSlashCommands } from "../../chat/commands.js";
import { Button } from "../../components/ui/button.js";
import { useEnduragentStore } from "../../state/store.js";
import { setupReady } from "../../state/onboarding-slice.js";
import { SlashPopup } from "./SlashPopup.js";

export interface ComposerHandle {
  focus(): void;
  reset(): void;
}

export function Composer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
}): ReactElement {
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listboxId = useId();
  const sendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const inputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);

  const matches = useMemo(() => filterSlashCommands(draft), [draft]);
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useImperativeHandle(
    props.handle,
    () => ({
      focus() {
        textarea.current?.focus();
      },
      reset() {
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

  const submit = (): void => {
    const input = textarea.current;
    if (input === null || sendDisabled || !canChat) return;
    const value = input.value;
    if (!/\S/u.test(value)) return;
    input.value = "";
    setDraft("");
    setSelected(0);
    setDismissed(false);
    actions?.submit(value);
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
      submit();
    }
  };

  return (
    <form
      ref={form}
      className="composer relative"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
      <label
        className="chat-composer__label mb-[7px] ml-[calc(var(--inset)*2)] block text-xs leading-[1.4] font-medium text-ink-2"
        htmlFor="message"
      >
        Message your coach
      </label>
      <div className="chat-composer__controls grid grid-cols-[minmax(0,1fr)_var(--ctl-h-lg)] items-center gap-2 rounded-card border border-line-2 bg-surface py-inset pr-inset pl-[calc(var(--inset)*2)] transition-[border-color,box-shadow] duration-120 motion-reduce:transition-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
        <textarea
          id="message"
          ref={textarea}
          className="min-h-10 max-h-[140px] resize-none border-0 bg-transparent py-2 text-ink outline-0 placeholder:text-[color-mix(in_srgb,var(--ink-2)_72%,transparent)] focus-visible:outline-0"
          rows={2}
          disabled={inputDisabled || !canChat}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open ? `${listboxId}-option-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setSelected(0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setDismissed(true);
          }}
        />
        <Button
          type="submit"
          variant="default"
          size="icon-lg"
          aria-label="Send message"
          disabled={sendDisabled || !canChat}
        >
          ↑
        </Button>
      </div>
    </form>
  );
}

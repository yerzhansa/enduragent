import type { ReactElement, RefObject } from "react";
import type { SlashCommand } from "../../chat/commands.js";
import { Popover, PopoverContent } from "../../components/ui/popover.js";
import { cn } from "../../lib/utils.js";

export function SlashPopup(props: {
  readonly open: boolean;
  readonly anchor: RefObject<Element | null>;
  readonly listboxId: string;
  readonly matches: readonly SlashCommand[];
  readonly selected: number;
  readonly onHighlight: (index: number) => void;
  readonly onAccept: (index: number) => void;
  readonly onDismiss: () => void;
}): ReactElement | null {
  if (!props.open) return null;

  return (
    <Popover
      open={props.open}
      modal={false}
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <PopoverContent
        anchor={props.anchor}
        side="top"
        sideOffset={8}
        align="start"
        className="block w-(--anchor-width) overflow-hidden p-0"
        id={props.listboxId}
        role="listbox"
        aria-label="Commands"
        initialFocus={false}
        finalFocus={false}
      >
        <div className="border-b border-line px-[calc(var(--inset)+var(--row-inset))] pt-2.5 pb-1.5 text-xs font-medium tracking-[0.07em] text-ink-3 uppercase">
          Commands
        </div>
        <ul className="m-0 list-none p-inset">
          {props.matches.map((match, index) => (
            <li
              key={match.command}
              id={`${props.listboxId}-option-${index}`}
              role="option"
              aria-selected={index === props.selected}
              className={cn(
                "flex cursor-default items-baseline gap-2 rounded-ctl px-row py-1.5 text-ink-2",
                index === props.selected && "bg-sunk text-ink",
              )}
              onMouseEnter={() => {
                props.onHighlight(index);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onAccept(index);
              }}
            >
              <span className="min-w-[86px] flex-none text-sm font-semibold text-ink">
                {match.command}
              </span>
              <span className="truncate text-sm text-ink-2">{match.description}</span>
            </li>
          ))}
        </ul>
        <div className="h-px bg-border" />
        <div className="flex gap-3.5 px-[calc(var(--inset)+var(--row-inset))] py-2 text-xs text-ink-3">
          <span>
            <span className="rounded-[4px] border border-line-2 border-b-2 bg-surface-2 px-1.5 py-px">
              ↑↓
            </span>{" "}
            choose
          </span>
          <span>
            <span className="rounded-[4px] border border-line-2 border-b-2 bg-surface-2 px-1.5 py-px">
              ↩
            </span>{" "}
            insert
          </span>
          <span>
            <span className="rounded-[4px] border border-line-2 border-b-2 bg-surface-2 px-1.5 py-px">
              esc
            </span>{" "}
            close
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";
import { cloneElement, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from "react";

export function InfoTip(props: {
  readonly label: string;
  readonly lead: string;
  readonly body: ReactNode;
  readonly trigger?: ReactElement<AnchorHTMLAttributes<HTMLAnchorElement>>;
  readonly triggerContent?: ReactNode;
}): ReactElement {
  const customTrigger = props.trigger !== undefined;
  const trigger =
    props.trigger === undefined ? undefined : cloneElement(props.trigger, { role: "link" });

  return (
    <Popover.Root>
      <Popover.Trigger
        render={trigger}
        nativeButton={!customTrigger}
        openOnHover
        data-info-tip=""
        aria-label={customTrigger ? undefined : props.label}
        className={
          customTrigger
            ? undefined
            : "grid size-6 shrink-0 appearance-none place-items-center bg-transparent p-0 text-ink-2 transition-colors hover:text-ink focus-visible:text-ink motion-reduce:transition-none"
        }
      >
        {props.triggerContent}
        <Info className="flex-none" size={14} strokeWidth={2.25} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8}>
          <Popover.Popup
            data-info-tip-popup=""
            className="w-[252px] rounded-md border border-line-2 bg-surface px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-elev-3"
            initialFocus={false}
            finalFocus={false}
          >
            <Popover.Title render={<b />} className="mb-1 block font-medium text-ink">
              {props.lead}
            </Popover.Title>
            <Popover.Description render={<div />}>{props.body}</Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

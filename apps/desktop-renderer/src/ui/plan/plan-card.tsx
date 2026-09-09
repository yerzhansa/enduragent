import type { ReactElement, ReactNode, Ref } from "react";
import { Card, CardContent, CardHeader } from "@enduragent/ui";

export function PlanCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary?: string;
  readonly summaryId?: string;
  readonly "aria-label": string;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly headingTabIndex?: number;
  readonly statusClassName?: string;
  readonly contentClassName?: string;
  readonly parityAttributes?: boolean;
  readonly headerChildren?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  const parity = props.parityAttributes !== false ? true : undefined;
  return (
    <Card
      size="sm"
      className="block min-w-0 gap-[normal] py-0"
      role="region"
      aria-label={props["aria-label"]}
    >
      <CardHeader className="block rounded-none p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0 justify-self-start">
            {props.eyebrow ? (
              <p
                data-plan-card-eyebrow={parity}
                className="mt-0 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2"
              >
                {props.eyebrow}
              </p>
            ) : null}
            <h3
              data-plan-card-title={parity}
              ref={props.headingRef}
              tabIndex={props.headingTabIndex}
              className="m-0 text-base leading-6 font-semibold break-words"
            >
              {props.title}
            </h3>
          </div>
          {props.status ? (
            <span
              data-plan-card-status={parity}
              className={
                props.statusClassName ??
                "inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2"
              }
            >
              {props.status}
            </span>
          ) : null}
        </div>
        {props.summary ? (
          <p
            data-plan-card-summary={parity}
            id={props.summaryId}
            className="mt-inset mb-0 text-sm leading-5 text-ink-2"
          >
            {props.summary}
          </p>
        ) : null}
        {props.headerChildren}
      </CardHeader>
      {props.children ? (
        <CardContent className={props.contentClassName ?? "px-4 pt-0 pb-4"}>
          {props.children}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function Fact(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly valueAs?: "strong" | "div";
}): ReactElement {
  const Value = props.valueAs ?? "strong";
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 border-b border-line py-[calc(var(--row-inset)+1px)] max-md:grid-cols-1 max-md:gap-1"
    >
      <span role="rowheader" className="text-xs leading-4 text-ink-2">
        {props.label}
      </span>
      <Value
        role="cell"
        className="text-right text-sm leading-5 font-medium [overflow-wrap:anywhere] max-md:text-left"
      >
        {props.children}
      </Value>
    </div>
  );
}

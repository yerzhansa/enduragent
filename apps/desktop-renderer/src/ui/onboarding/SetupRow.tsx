import { usePhrasebook } from "@enduragent/i18n/react";
import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { OnboardingSurfaceState } from "../../onboarding/controller";
import { errorSection, type SetupErrorSection } from "../../onboarding/lanes";
import { ERROR_COPY } from "./copy";

export type SetupRowStatus = "ready" | "pending" | "none";

const TITLE_CLASS = "flex items-center gap-1.5 text-sm font-medium";

function StatusDisc(props: { readonly status: SetupRowStatus }): ReactElement | null {
  if (props.status === "none") return null;
  if (props.status === "ready") {
    return (
      <span
        data-setup-disc="ready"
        className="grid size-[18px] shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ok)_18%,transparent)] text-ok"
      >
        <Check size={11} strokeWidth={3.2} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      data-setup-disc="pending"
      className="size-[18px] shrink-0 rounded-full border border-dashed border-line-2"
    />
  );
}

export function SetupRow(props: {
  readonly id: string;
  readonly dataProvider?: string;
  readonly status: SetupRowStatus;
  readonly title: string;
  readonly subtitle: ReactNode;
  readonly info?: ReactNode;
  readonly trailing?: ReactNode;
  readonly titleFor?: string;
  readonly announce?: string;
}): ReactElement {
  const title =
    props.titleFor === undefined ? (
      <span className={TITLE_CLASS} data-setup-row-title="">
        {props.title}
        {props.info}
      </span>
    ) : (
      <label className={TITLE_CLASS} data-setup-row-title="" htmlFor={props.titleFor}>
        {props.title}
        {props.info}
      </label>
    );

  return (
    <div
      className="flex w-full items-center gap-[11px] px-[15px] py-3"
      data-setup-row={props.id}
      data-state={props.status}
      {...(props.dataProvider === undefined ? {} : { "data-provider": props.dataProvider })}
    >
      <StatusDisc status={props.status} />
      <div className="min-w-0 flex-1">
        {title}
        <span className="mt-px block text-xs text-ink-2" data-setup-row-subtitle="">
          {props.subtitle}
        </span>
        <span className="sr-only" role="status" aria-live="polite" data-setup-announce={props.id}>
          {props.announce ?? ""}
        </span>
      </div>
      {props.trailing}
    </div>
  );
}

export function SetupSubPanel(props: {
  readonly name: string;
  readonly id?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      className="flex w-full items-start gap-[11px] bg-sunk px-[15px] py-3"
      data-setup-panel={props.name}
      {...(props.id === undefined ? {} : { id: props.id })}
    >
      <span className="w-[18px] shrink-0" />
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

export function SetupError(props: {
  readonly surface: OnboardingSurfaceState;
  readonly section: SetupErrorSection;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const wizard = props.surface.wizard;
  if (errorSection(wizard.fixedError, props.surface.lastCommit) !== props.section) return null;
  return (
    <p id="onboarding-error" className="mt-2 text-sm text-danger">
      {wizard.fixedError === null ? "" : say(ERROR_COPY[wizard.fixedError])}
    </p>
  );
}

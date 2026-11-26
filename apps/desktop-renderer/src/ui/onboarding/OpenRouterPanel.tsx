import { msg, type Message } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import type { ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller";
import type { OpenRouterSignInView } from "../../onboarding/openrouter-sign-in";
import { OPENROUTER_COPY } from "./copy";
import { SETUP_LINK_BUTTON } from "./SetupCard";
import { SetupError, SetupSubPanel } from "./SetupRow";

export type OpenRouterPanelState =
  | "idle"
  | "sign-in-again"
  | "waiting"
  | "completing"
  | "no-credits"
  | "code"
  | "code-problem"
  | "code-expired"
  | "not-finished"
  | "unreachable"
  | "saved-not-active"
  | "not-saved";

type Handler = "cancel" | "revert" | "pasteKey" | keyof OnboardingActions["openRouter"];

interface PanelAction {
  readonly label: Message;
  readonly run?: Handler;
  readonly variant?: "default" | "ghost" | "outline";
}

interface PanelContent {
  readonly heading?: Message;
  readonly hint?: Message;
  readonly steps?: readonly Message[];
  readonly status?: { readonly copy: Message; readonly danger: boolean };
  readonly buttons: readonly PanelAction[];
  readonly links?: readonly PanelAction[];
}

const COPY = OPENROUTER_COPY;
const CANCEL: PanelAction = { label: msg("common.cancel"), run: "revert", variant: "ghost" };
const CANCEL_SIGN_IN: PanelAction = { label: COPY.cancelSignIn, run: "cancel", variant: "ghost" };
const TRY_AGAIN: PanelAction = { label: COPY.tryAgain, run: "start" };
const PASTE_KEY: PanelAction = { label: COPY.pasteInstead, run: "pasteKey" };
const ENTER_CODE: PanelAction = { label: COPY.enterCode, run: "enterCode" };
const CODE = { heading: COPY.codeHeading, hint: COPY.codeHint, steps: COPY.codeSteps } as const;
const CODE_BUTTONS: readonly PanelAction[] = [
  CANCEL_SIGN_IN,
  { label: COPY.codeOpen, run: "reopen", variant: "outline" },
  { label: COPY.codeUse, run: "useCopiedCode" },
];

const PANEL_CONTENT: Readonly<Record<OpenRouterPanelState, PanelContent>> = {
  idle: {
    hint: COPY.hint,
    buttons: [CANCEL, { label: COPY.signIn, run: "start" }],
    links: [PASTE_KEY],
  },
  "sign-in-again": {
    hint: COPY.signInAgainHint,
    buttons: [CANCEL, { label: COPY.signInAgain, run: "start" }],
    links: [PASTE_KEY],
  },
  waiting: {
    hint: COPY.waitingHint,
    buttons: [CANCEL_SIGN_IN, { label: COPY.waiting }],
    links: [{ label: COPY.reopen, run: "reopen" }, ENTER_CODE],
  },
  completing: { hint: COPY.completingHint, buttons: [{ label: COPY.completing }] },
  "no-credits": {
    hint: COPY.noCreditsHint,
    status: { copy: COPY.noCreditsStatus, danger: false },
    buttons: [
      { label: COPY.checkAgain, run: "checkCredits", variant: "ghost" },
      { label: COPY.addCredits, run: "addCredits" },
    ],
  },
  code: { ...CODE, status: { copy: COPY.codeStatus, danger: false }, buttons: CODE_BUTTONS },
  "code-problem": {
    ...CODE,
    status: { copy: COPY.codeNoCode, danger: true },
    buttons: CODE_BUTTONS,
  },
  "code-expired": {
    ...CODE,
    status: { copy: COPY.codeExpired, danger: true },
    buttons: [CANCEL_SIGN_IN, { label: COPY.codeNew, run: "enterCode" }],
  },
  "not-finished": {
    status: { copy: COPY.notFinished, danger: true },
    buttons: [CANCEL, TRY_AGAIN],
    links: [ENTER_CODE],
  },
  unreachable: { status: { copy: COPY.unreachable, danger: true }, buttons: [CANCEL, TRY_AGAIN] },
  "saved-not-active": {
    hint: COPY.savedHint,
    status: { copy: COPY.savedNotActive, danger: true },
    buttons: [{ label: COPY.retryActivation, run: "retryActivation" }],
  },
  "not-saved": {
    status: { copy: COPY.notSaved, danger: true },
    buttons: [CANCEL, TRY_AGAIN],
    links: [{ label: COPY.openKeys, run: "openKeys" }],
  },
};

export function openRouterPanelState(
  view: OpenRouterSignInView,
  input: { readonly connected: boolean; readonly picked: boolean },
): OpenRouterPanelState {
  const signIn = view.signIn;
  switch (signIn.phase) {
    case "waiting-for-browser":
      return "waiting";
    case "completing-sign-in":
      return "completing";
    case "awaiting-code":
      if (signIn.problem === null) return "code";
      return signIn.problem === "code-expired" ? "code-expired" : "code-problem";
    case "failed":
      return signIn.reason;
    case "idle":
      if (!input.connected) return "idle";
      return input.picked || view.credit !== "never-paid" ? "sign-in-again" : "no-credits";
  }
}

export function OpenRouterPanel(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly state: OpenRouterPanelState;
  readonly controlsDisabled: boolean;
  readonly onRevert: () => void;
  readonly onPasteKey: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const content = PANEL_CONTENT[props.state];
  const activating = props.surface.openRouter.activating;
  const run = (handler: Handler | undefined): void => {
    if (handler === "revert") props.onRevert();
    else if (handler === "pasteKey") props.onPasteKey();
    else if (handler !== undefined) props.actions?.openRouter[handler]();
  };
  const disabled = (action: PanelAction): boolean =>
    action.run === undefined ||
    props.actions === null ||
    (action.run === "cancel" ? false : props.controlsDisabled || activating);
  return (
    <SetupSubPanel name="openrouter">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-7 gap-y-3"
        data-openrouter-state={props.state}
      >
        <div className="min-w-52 flex-1 text-xs leading-normal text-ink-2">
          {content.heading === undefined ? null : (
            <h3 className="m-0 text-sm font-medium text-ink">{say(content.heading)}</h3>
          )}
          {content.hint === undefined ? null : (
            <p className={content.heading === undefined ? "m-0" : "mt-1 mb-0"}>
              {say(content.hint)}
            </p>
          )}
          {content.steps === undefined ? null : (
            <ol className="mt-1.5 mb-0 list-decimal pl-4">
              {content.steps.map((step) => (
                <li key={step.key}>{say(step)}</li>
              ))}
            </ol>
          )}
          {content.hint === undefined && content.status?.danger === true ? (
            <p className="m-0 text-danger" role="status" aria-live="polite" aria-atomic="true">
              {say(content.status.copy)}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {content.buttons.map((action) => (
            <Button
              key={action.label.key}
              type="button"
              variant={action.variant ?? "default"}
              size="sm"
              disabled={disabled(action)}
              onClick={() => run(action.run)}
            >
              {action.run === "retryActivation" && activating
                ? say(COPY.activating)
                : say(action.label)}
            </Button>
          ))}
        </div>
      </div>
      {content.status === undefined ||
      (content.hint === undefined && content.status.danger) ? null : (
        <p
          className={`mt-[7px] text-xs ${content.status.danger ? "text-danger" : "text-ink-2"}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {say(content.status.copy)}
        </p>
      )}
      {(content.links ?? []).map((action) => (
        <Button
          key={action.label.key}
          type="button"
          variant="link"
          size="sm"
          className={SETUP_LINK_BUTTON}
          disabled={disabled(action)}
          onClick={() => run(action.run)}
        >
          {say(action.label)}
        </Button>
      ))}
      <SetupError surface={props.surface} section="provider" />
    </SetupSubPanel>
  );
}

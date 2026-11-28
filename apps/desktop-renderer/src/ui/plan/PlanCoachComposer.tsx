import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { Paperclip } from "lucide-react";
import type { ReactElement, RefObject } from "react";
import { useEnduragentStore } from "../../state/store";
import { Composer, type ComposerHandle } from "../chat/Composer";

export function PlanCoachComposer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
  readonly busy: boolean;
  readonly courseUndecided: boolean;
  readonly decisionUnanswered: boolean;
  readonly answerEditorOpen: boolean;
}): ReactElement {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.planActions);
  const coach = useEnduragentStore((state) => state.plan.coach);
  const courseActionsDisabled =
    actions === null || props.busy || coach.status === "streaming" || props.answerEditorOpen;
  return (
    <Composer
      handle={props.handle}
      inputId="plan-coach-composer"
      lockedPlaceholder={props.answerEditorOpen ? say("chat.composer.finishAnswer") : undefined}
      leadingAction={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={say("plan.view.planCoach.attachRaceCourse")}
            disabled={courseActionsDisabled}
            onClick={() => actions?.openCoursePicker()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
          {props.courseUndecided ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={courseActionsDisabled}
              onClick={() => actions?.continueWithoutCourse()}
            >
              {say("plan.view.planCoach.continueWithoutCourse")}
            </Button>
          ) : null}
        </div>
      }
      surface={{
        status: coach.status,
        sendDisabled: coach.sendDisabled,
        inputDisabled: coach.inputDisabled || props.decisionUnanswered,
        placeholder: say("plan.view.planCoach.replyPlaceholder"),
        label: say("plan.view.planCoach.replyLabel"),
        allowSlashCommands: false,
        submit: (message) => actions?.submitCoach(message) ?? Promise.resolve(false),
        stop: () => actions?.stopCoach(),
      }}
    />
  );
}

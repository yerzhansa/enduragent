import { usePhrasebook } from "@enduragent/i18n/react";
import type { WorkoutArchiveFormat } from "@enduragent/coach-contract";
import { useId, useState, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import {
  trainingExportStatusCopy,
  type TrainingExportTarget,
} from "../../training-export/controller";
import { overviewStyles as styles } from "./overviewStyles";

const WORKOUT_FORMATS = [
  { value: "zwo", label: "ZWO" },
  { value: "mrc", label: "MRC" },
  { value: "erg", label: "ERG" },
  { value: "fit", label: "FIT" },
] as const;

function Status(props: { readonly target: TrainingExportTarget }): ReactElement {
  const { say } = usePhrasebook();
  const state = useEnduragentStore((store) => store.trainingExport);
  const copy =
    state.status === "idle" || state.target !== props.target
      ? null
      : trainingExportStatusCopy(state);
  return (
    <p
      className={styles.exportStatus}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      hidden={copy === null}
    >
      {copy === null ? null : say(copy)}
    </p>
  );
}

export function WorkoutArchiveExportControl(props: {
  readonly oldest: string;
  readonly newest: string;
}): ReactElement {
  const { say } = usePhrasebook();
  const id = useId();
  const [format, setFormat] = useState<WorkoutArchiveFormat>("zwo");
  const state = useEnduragentStore((store) => store.trainingExport);
  const actions = useEnduragentStore((store) => store.trainingExportActions);
  const busy = state.status === "running";
  return (
    <div>
      <p className={styles.support}>{say("training.export.description")}</p>
      <div className={styles.exportControls}>
        <label className="font-medium" htmlFor={`${id}-format`}>
          {say("training.export.formatLabel")}
        </label>
        <Select
          items={WORKOUT_FORMATS}
          value={format}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== null) setFormat(value as WorkoutArchiveFormat);
          }}
        >
          <SelectTrigger id={`${id}-format`} className="min-w-[86px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {WORKOUT_FORMATS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          aria-busy={busy ? "true" : undefined}
          onClick={() => {
            void actions?.exportWorkoutArchive({ ...props, format });
          }}
        >
          {say("training.export.saveWorkouts")}
        </Button>
      </div>
      <Status target="workout-archive" />
    </div>
  );
}

import type {
  ListPlansResult,
  PlanChangeIntent,
  SupportingEvent,
} from "@enduragent/coach-contract";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import { useEffect, useState, type ReactElement } from "react";

type EventIntent = Extract<PlanChangeIntent, { kind: "supporting-event" }>;
const operations = [
  { value: "add", label: "Add a Supporting Event" },
  { value: "remove", label: "Remove a Supporting Event" },
  { value: "role", label: "Change a Supporting Event role" },
  { value: "manual", label: "Correct a Supporting Event" },
  { value: "source-update", label: "Accept synchronized event details" },
  { value: "name", label: "Rename a Supporting Event" },
] satisfies Array<{ value: EventIntent["operation"]; label: string }>;
const roles = [
  { value: "Important", label: "Important" },
  { value: "Training", label: "Training" },
] satisfies Array<{ value: SupportingEvent["role"]; label: string }>;

export function SupportingEventFields(props: {
  events: SupportingEvent[];
  candidates: NonNullable<ListPlansResult["active"]>["supportingEventCandidates"];
  busy: boolean;
  onIntentChange: (intent: EventIntent) => void;
}): ReactElement {
  const [operation, setOperation] = useState<EventIntent["operation"]>("add");
  const [eventId, setEventId] = useState(props.events[0]?.id ?? "");
  const [candidateId, setCandidateId] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [role, setRole] = useState<SupportingEvent["role"]>("Training");
  const selected = props.events.find((event) => event.id === eventId);
  const candidate = props.candidates.find((event) => event.providerId === candidateId);
  const { onIntentChange } = props;
  useEffect(() => {
    const kind = "supporting-event";
    switch (operation) {
      case "add":
        onIntentChange({
          kind,
          operation,
          name: candidate?.name ?? name,
          date: candidate?.date ?? date,
          role,
          ...(candidate ? { providerId: candidate.providerId } : {}),
        });
        break;
      case "remove":
      case "source-update":
        onIntentChange({ kind, operation, eventId });
        break;
      case "role":
        onIntentChange({ kind, operation, eventId, role });
        break;
      case "manual":
        onIntentChange({ kind, operation, eventId, name, date });
        break;
      case "name":
        onIntentChange({ kind, operation, eventId, name });
        break;
    }
  }, [operation, eventId, name, date, role, candidate, onIntentChange]);
  const chooseEvent = (id: string): void => {
    setEventId(id);
    const event = props.events.find((item) => item.id === id);
    setName(event?.name ?? "");
    setDate(event?.date ?? "");
    setRole(event?.role ?? "Training");
  };
  const select = (
    id: string,
    label: string,
    value: string,
    items: Array<{ value: string; label: string }>,
    onChange: (value: string) => void,
  ): ReactElement => (
    <div className="grid gap-[calc(var(--inset)/2)]">
      <label htmlFor={id} className="text-xs text-ink-2">
        {label}
      </label>
      <Select
        value={value}
        items={items}
        disabled={props.busy}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <>
      {select(
        "plan-change-event-operation",
        "Supporting Event operation",
        operation,
        operations,
        (value) => {
          const option = operations.find((item) => item.value === value);
          if (!option) return;
          setOperation(option.value);
          if (option.value === "add") {
            setName("");
            setDate("");
            setRole("Training");
          } else chooseEvent(eventId || props.events[0]?.id || "");
        },
      )}
      {operation !== "add"
        ? select(
            "plan-change-event-accepted",
            "Accepted Supporting Event",
            eventId,
            props.events.map((event) => ({ value: event.id, label: event.name })),
            chooseEvent,
          )
        : null}
      {operation !== "add" && props.events.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">This Plan has no accepted Supporting Events.</p>
      ) : null}
      {operation === "add" && props.candidates.length > 0
        ? select(
            "plan-change-event-source",
            "Synchronized event",
            candidateId,
            [
              { value: "", label: "Manual entry" },
              ...props.candidates.map((event) => ({
                value: event.providerId,
                label: `${event.name} · ${event.sourceLabel}`,
              })),
            ],
            setCandidateId,
          )
        : null}
      {operation === "name" || operation === "manual" || (operation === "add" && !candidate) ? (
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label htmlFor="plan-change-event-name" className="text-xs text-ink-2">
            Event name
          </label>
          <input
            id="plan-change-event-name"
            type="text"
            maxLength={512}
            value={name}
            disabled={props.busy}
            onChange={(event) => setName(event.target.value)}
            className="min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-normal leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          />
        </div>
      ) : null}
      {operation === "manual" || (operation === "add" && !candidate) ? (
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label htmlFor="plan-change-event-date" className="text-xs text-ink-2">
            Event date
          </label>
          <input
            id="plan-change-event-date"
            type="date"
            value={date}
            disabled={props.busy}
            onChange={(event) => setDate(event.target.value)}
            className="min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-normal leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          />
        </div>
      ) : null}
      {operation === "add" || operation === "role"
        ? select("plan-change-event-role", "Plan role", role, roles, (value) => {
            const next = roles.find((item) => item.value === value);
            if (next) setRole(next.value);
          })
        : null}
      {operation === "source-update" && selected ? (
        <p className="m-0 text-sm text-ink-2">
          Review the synchronized name and date in a fresh preview before accepting them.
        </p>
      ) : null}
    </>
  );
}

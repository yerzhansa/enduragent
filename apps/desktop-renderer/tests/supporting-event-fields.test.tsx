import type { SupportingEvent } from "@enduragent/coach-contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SupportingEventFields } from "../src/ui/chat/SupportingEventFields";

const events: SupportingEvent[] = [
  {
    id: "river",
    name: "River ride",
    date: "1998-01-10",
    role: "Training",
    source: { kind: "manual" },
  },
  {
    id: "hill",
    name: "Hill ride",
    date: "1998-01-17",
    role: "Important",
    source: { kind: "synced", providerId: "17", sourceRevision: "a".repeat(64) },
  },
];

async function choose(label: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Supporting Event fields", () => {
  it("offers every operation and sends only its contract fields", async () => {
    const onIntentChange = vi.fn();
    render(
      <SupportingEventFields
        events={events}
        candidates={[]}
        busy={false}
        onIntentChange={onIntentChange}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Supporting Event operation" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Add a Supporting Event",
      "Remove a Supporting Event",
      "Change a Supporting Event role",
      "Correct a Supporting Event",
      "Accept synchronized event details",
      "Rename a Supporting Event",
    ]);
    await userEvent.click(await screen.findByRole("option", { name: "Remove a Supporting Event" }));
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "remove",
      eventId: "river",
    });
    expect(screen.queryByLabelText("Event name")).toBeNull();
    await choose("Supporting Event operation", "Change a Supporting Event role");
    await choose("Plan role", "Important");
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "role",
      eventId: "river",
      role: "Important",
    });
    await choose("Supporting Event operation", "Correct a Supporting Event");
    expect(screen.getByLabelText("Event name")).toHaveValue("River ride");
    expect(screen.getByLabelText("Event date")).toHaveValue("1998-01-10");
    await userEvent.clear(screen.getByLabelText("Event name"));
    await userEvent.type(screen.getByLabelText("Event name"), "New river ride");
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "manual",
      eventId: "river",
      name: "New river ride",
      date: "1998-01-10",
    });
    await choose("Accepted Supporting Event", "Hill ride");
    expect(screen.getByLabelText("Event name")).toHaveValue("Hill ride");
    expect(screen.getByLabelText("Event date")).toHaveValue("1998-01-17");
    await choose("Supporting Event operation", "Accept synchronized event details");
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "source-update",
      eventId: "hill",
    });
    expect(screen.queryByLabelText("Event name")).toBeNull();
    await choose("Supporting Event operation", "Rename a Supporting Event");
    await userEvent.clear(screen.getByLabelText("Event name"));
    await userEvent.type(screen.getByLabelText("Event name"), "Hill challenge");
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "name",
      eventId: "hill",
      name: "Hill challenge",
    });
    expect(screen.queryByLabelText("Event date")).toBeNull();
  });

  it("labels provider candidates and uses their provider identity without changing source details", async () => {
    const onIntentChange = vi.fn();
    render(
      <SupportingEventFields
        events={[]}
        candidates={[
          {
            providerId: "17",
            name: "Hill ride",
            date: "1998-01-17",
            category: "RACE_B",
            sourceLabel: "Intervals.icu event",
          },
        ]}
        busy={false}
        onIntentChange={onIntentChange}
      />,
    );
    await choose("Synchronized event", "Hill ride · Intervals.icu event");
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "add",
      providerId: "17",
      name: "Hill ride",
      date: "1998-01-17",
      role: "Training",
    });
    expect(screen.queryByLabelText("Event name")).toBeNull();
    expect(screen.queryByLabelText("Event date")).toBeNull();
    await choose("Synchronized event", "Manual entry");
    expect(screen.getByLabelText("Event name")).toBeEnabled();
    expect(onIntentChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "add",
      name: "",
      date: "",
      role: "Training",
    });
  });

  it("shows the empty accepted list and disables every control while busy", async () => {
    const onIntentChange = vi.fn();
    const view = render(
      <SupportingEventFields
        events={[]}
        candidates={[]}
        busy={false}
        onIntentChange={onIntentChange}
      />,
    );
    await choose("Supporting Event operation", "Correct a Supporting Event");
    expect(screen.getByText("This Plan has no accepted Supporting Events.")).toBeVisible();
    view.rerender(
      <SupportingEventFields events={[]} candidates={[]} busy onIntentChange={onIntentChange} />,
    );
    for (const control of screen.getAllByRole("combobox")) expect(control).toBeDisabled();
    expect(screen.getByLabelText("Event name")).toBeDisabled();
    expect(screen.getByLabelText("Event date")).toBeDisabled();
  });
});

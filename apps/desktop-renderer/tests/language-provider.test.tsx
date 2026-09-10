import { LanguageProvider, useLanguageReady, usePhrasebook } from "@enduragent/i18n/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

function PhrasebookConsumer() {
  const phrasebook = usePhrasebook();
  const ready = useLanguageReady();
  const [draft, setDraft] = useState("");
  return (
    <>
      <p data-ready={ready}>{phrasebook.say("language.chooseTitle")}</p>
      <output>{phrasebook.format.number(12345.5)}</output>
      <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </>
  );
}

describe("LanguageProvider", () => {
  it("renders nothing until its first catalog is ready", async () => {
    const { container } = render(
      <LanguageProvider tag="en" locale="en-GB">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(await screen.findByText("Choose your language")).toHaveAttribute("data-ready", "true");
  });

  it("keeps local drafts while replacing a loaded phrasebook and locale", async () => {
    const { rerender } = render(
      <LanguageProvider tag="en" locale="en-GB">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );
    const draft = await screen.findByRole("textbox", { name: "Draft" });
    await userEvent.type(draft, "Saved draft");

    rerender(
      <LanguageProvider tag="it" locale="it-IT">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(screen.getByText("Choose your language")).toHaveAttribute("data-ready", "false");
    expect(await screen.findByText("Scegli la tua lingua")).toHaveAttribute("data-ready", "true");
    expect(draft).toHaveValue("Saved draft");
    expect(screen.getByRole("status")).toHaveTextContent("12.345,5");

    rerender(
      <LanguageProvider tag="it" locale="en-GB">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("12,345.5"));
    expect(draft).toHaveValue("Saved draft");
  });

  it("isolates a nested highlighted language from the application language", async () => {
    render(
      <LanguageProvider tag="en" locale="en-GB">
        <PhrasebookConsumer />
        <LanguageProvider tag="ja" locale="ja-JP">
          <PhrasebookConsumer />
        </LanguageProvider>
      </LanguageProvider>,
    );

    expect(await screen.findByText("Choose your language")).toBeVisible();
    expect(await screen.findByText("言語を選んでください")).toBeVisible();
  });

  it("settles on the last requested language after rapid changes", async () => {
    const { rerender } = render(
      <LanguageProvider tag="en" locale="en-GB">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );
    await screen.findByText("Choose your language");

    rerender(
      <LanguageProvider tag="it" locale="it-IT">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );
    rerender(
      <LanguageProvider tag="ja" locale="ja-JP">
        <PhrasebookConsumer />
      </LanguageProvider>,
    );

    expect(await screen.findByText("言語を選んでください")).toHaveAttribute("data-ready", "true");
    expect(screen.queryByText("Scegli la tua lingua")).not.toBeInTheDocument();
  });
});

import { useRef } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { filterSlashCommands } from "../src/chat/commands";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { AttachmentPanel } from "../src/ui/chat/AttachmentPanel";
import { ChatView } from "../src/ui/chat/ChatView";
import { Composer, type ComposerHandle } from "../src/ui/chat/Composer";
import { FirstSyncCard } from "../src/ui/chat/FirstSyncCard";
import { HistoryControls } from "../src/ui/chat/HistoryControls";
import { NewConversationDialog } from "../src/ui/chat/NewConversationDialog";
import { QueuedMessages } from "../src/ui/chat/QueuedMessages";
import { SlashPopup } from "../src/ui/chat/SlashPopup";
import { Transcript } from "../src/ui/chat/Transcript";
import { PreferencesSection } from "../src/ui/settings/PreferencesSection";
import { renderWithCatalog } from "./language-harness";

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    runtimeReady: true,
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    firstSync: { status: "idle" },
    onboarding: READY_ONBOARDING,
    planLibrary: { status: "loading", value: null },
    settings: {
      ...EMPTY_SETTINGS_SURFACE,
      language: { status: "ready", value: "it" },
    },
  });
});

function ComposerExample() {
  const handle = useRef<ComposerHandle>(null);
  return <Composer handle={handle} />;
}

function SlashExample() {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor}>
      <SlashPopup
        open
        anchor={anchor}
        listboxId="catalog-commands"
        matches={filterSlashCommands("/sta")}
        selected={0}
        onHighlight={() => undefined}
        onAccept={() => undefined}
        onDismiss={() => undefined}
      />
    </div>
  );
}

describe("Chat catalog rendering", () => {
  it("renders attachment rejection copy from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        attachmentAdmissions: [
          {
            selectionId: "synthetic-selection",
            displayName: "training.unsupported",
            status: "rejected",
            reason: "format_unsupported",
          },
        ],
      },
    });
    await renderWithCatalog(<AttachmentPanel />, {
      chat: {
        attachment: {
          unknownFormat: "Formato sconosciuto",
          unsupportedTitle: "Questo file non è supportato",
          chooseFile: "Scegli un file",
          dismiss: "Chiudi avviso",
        },
      },
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("training.unsupported");
    expect(alert).toHaveTextContent("Formato sconosciuto");
    expect(alert).toHaveTextContent("Questo file non è supportato");
    expect(within(alert).getByRole("button", { name: "Scegli un file" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Chiudi avviso" })).toBeVisible();
  });

  it("renders queue counts and removal labels while preserving message data", async () => {
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        queued: [
          {
            id: "synthetic-message",
            text: "Keep my original message.",
            command: false,
            restored: false,
          },
        ],
      },
    });
    await renderWithCatalog(<QueuedMessages />, {
      chat: {
        queued: {
          title: "Messaggi in attesa",
          count_one: "{{number}} messaggio in attesa",
          label: "Coda: {{queueLabel}}",
          removeLabel: "Rimuovi messaggio {{number}}",
          remove: "Rimuovi",
        },
      },
    });
    expect(screen.getByText("Messaggi in attesa")).toBeVisible();
    expect(screen.getByLabelText("Coda: 1 messaggio in attesa")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rimuovi messaggio 1" })).toBeVisible();
    expect(screen.getByText("Keep my original message.")).toBeVisible();
  });

  it("renders first sync status and accessible progress from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({ firstSync: { status: "syncing" } });
    await renderWithCatalog(<FirstSyncCard />, {
      chat: {
        firstSync: {
          eyebrow: "Primo collegamento",
          syncingTitle: "Sincronizzazione in corso",
          syncingDetail: "{{product}} sta preparando i dati.",
          progress: "Caricamento allenamenti",
        },
      },
    });
    expect(screen.getByRole("region", { name: "Sincronizzazione in corso" })).toBeVisible();
    expect(screen.getByText("Enduragent sta preparando i dati.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Caricamento allenamenti" })).toBeVisible();
  });

  it("renders history failure and recovery from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({ chat: { ...EMPTY_CHAT_SURFACE, hydrationStatus: "failed" } });
    await renderWithCatalog(<HistoryControls />, {
      chat: {
        history: { failure: "La cronologia non è disponibile.", retry: "Ricarica cronologia" },
      },
    });
    expect(screen.getByText("La cronologia non è disponibile.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ricarica cronologia" })).toBeVisible();
  });

  it("renders new conversation confirmation from the supplied Italian catalog", async () => {
    useEnduragentStore.setState({ chat: { ...EMPTY_CHAT_SURFACE, resetPhase: "confirming" } });
    await renderWithCatalog(<NewConversationDialog onComposerReset={() => undefined} />, {
      chat: {
        newConversation: {
          title: "Nuova conversazione?",
          base: "La conversazione attuale verrà archiviata.",
          cancel: "Annulla richiesta",
          confirm: "Inizia conversazione",
        },
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "Nuova conversazione?" });
    expect(dialog).toHaveAccessibleDescription("La conversazione attuale verrà archiviata.");
    expect(within(dialog).getByRole("button", { name: "Annulla richiesta" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Inizia conversazione" })).toBeVisible();
  });

  it("renders composer labels and its placeholder from the supplied Italian catalog", async () => {
    await renderWithCatalog(<ComposerExample />, {
      chat: {
        composer: {
          label: "Messaggio al coach",
          messagePlaceholder: "Scrivi al tuo coach",
          attach: "Allega un file",
        },
      },
    });
    expect(screen.getByRole("combobox", { name: "Messaggio al coach" })).toHaveAttribute(
      "placeholder",
      "Scrivi al tuo coach",
    );
    expect(screen.getByRole("button", { name: "Allega un file" })).toBeVisible();
  });

  it("renders slash command descriptions through their Message catalog keys", async () => {
    await renderWithCatalog(<SlashExample />, {
      chat: {
        slashPopup: {
          title: "Comandi rapidi",
          choose: "scegli",
          insert: "inserisci",
          close: "chiudi",
        },
        commands: { start: "Inizia una nuova sessione", status: "Controlla la forma attuale" },
      },
    });
    const commands = await screen.findByRole("listbox", { name: "Comandi rapidi" });
    expect(
      within(commands).getByRole("option", { name: "/startInizia una nuova sessione" }),
    ).toBeVisible();
    expect(
      within(commands).getByRole("option", { name: "/statusControlla la forma attuale" }),
    ).toBeVisible();
  });

  it("renders transcript labels and saved choices while preserving authored content", async () => {
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        timeline: [
          {
            kind: "message",
            message: {
              id: "synthetic-athlete",
              role: "athlete",
              delivery: "complete",
              historical: false,
              text: "My original English message.",
            },
          },
          {
            kind: "message",
            message: {
              id: "synthetic-coach",
              role: "coach",
              delivery: "complete",
              historical: false,
              text: "The original coach reply.",
            },
          },
          {
            kind: "choice",
            choice: {
              id: "synthetic-choice",
              label: "Question skipped",
              consequence: "No coaching choice was applied.",
              skipped: true,
              historical: false,
            },
          },
        ],
      },
    });
    await renderWithCatalog(<Transcript />, {
      chat: {
        transcript: {
          label: "Conversazione con il coach",
          athleteLabel: "Tu",
          coachLabel: "Allenatore",
          choice: "La tua scelta",
        },
        notice: {
          questionSkipped: "Domanda saltata",
          choiceUnchanged: "Nessuna scelta applicata.",
        },
      },
    });
    const transcript = screen.getByRole("log", { name: "Conversazione con il coach" });
    expect(transcript).toHaveTextContent("Tu");
    expect(transcript).toHaveTextContent("Allenatore");
    expect(transcript).toHaveTextContent("My original English message.");
    expect(transcript).toHaveTextContent("The original coach reply.");
    expect(within(transcript).getByRole("article", { name: "La tua scelta" })).toHaveTextContent(
      "Domanda saltata",
    );
    expect(transcript).toHaveTextContent("Nessuna scelta applicata.");
  });

  it("preserves authored choice text that happens to match UI feedback", async () => {
    useEnduragentStore.setState({
      chat: {
        ...EMPTY_CHAT_SURFACE,
        timeline: [
          {
            kind: "choice",
            choice: {
              id: "synthetic-authored-choice",
              label: "Question skipped",
              consequence: "No coaching choice was applied.",
              skipped: false,
              historical: true,
            },
          },
        ],
      },
    });
    await renderWithCatalog(<Transcript />, {
      chat: {
        notice: {
          questionSkipped: "Domanda saltata",
          choiceUnchanged: "Nessuna scelta applicata.",
        },
      },
    });
    expect(screen.getByRole("log")).toHaveTextContent("Question skipped");
    expect(screen.getByRole("log")).toHaveTextContent("No coaching choice was applied.");
    expect(screen.getByRole("log")).not.toHaveTextContent("Domanda saltata");
  });

  it("renders Chat title and context toggle labels from the supplied Italian catalog", async () => {
    await renderWithCatalog(<ChatView />, {
      chat: {
        view: {
          title: "Conversazione",
          hideContext: "Nascondi contesto",
          showContext: "Mostra contesto",
          conversation: "Area conversazione",
          disclaimer: "Controlla i suggerimenti del coach.",
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Conversazione", level: 1 })).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Nascondi contesto" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Mostra contesto" })).toBeVisible();
    expect(screen.getByText("Controlla i suggerimenti del coach.")).toBeVisible();
  });

  it("renders all Palette copy from the supplied Italian catalog", async () => {
    await renderWithCatalog(<PreferencesSection />, {
      settings: {
        palette: {
          title: "Tavolozza",
          app: "Tavolozza dell’app",
          detail: "Modifica entrambi i temi · {{palette}} è predefinita",
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Tavolozza" })).toBeVisible();
    const palette = screen.getByRole("region", { name: "Tavolozza" });
    expect(palette).toHaveTextContent("Tavolozza dell’app");
    expect(palette).toHaveTextContent("Modifica entrambi i temi · Patrol è predefinita");
    expect(useEnduragentStore.getState().settings.language.value).toBe("it");
  });
});

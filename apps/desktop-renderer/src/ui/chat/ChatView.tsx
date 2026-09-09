import { PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { CHAT_AUTO_LOAD_EARLIER_THRESHOLD, chatScrollAnchor } from "../../state/chat-stream";
import { useEnduragentStore } from "../../state/store";
import { Button } from "@enduragent/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@enduragent/ui";
import { Composer, type ComposerHandle } from "./Composer";
import { AttachmentPanel } from "./AttachmentPanel";
import { CoachDecisionPanel } from "./CoachDecisionPanel";
import { FirstSyncCard } from "./FirstSyncCard";
import { NewConversationDialog } from "./NewConversationDialog";
import { CoachProgress, Notice, RetryBar } from "./Notice";
import { QueuedMessages } from "./QueuedMessages";
import { SpendNotice } from "./SpendNotice";
import { TrainingContextPanel } from "./TrainingContextPanel";
import { Transcript } from "./Transcript";
import { PlanChangeCards } from "./PlanChangeCards";
import {
  PlanCreationActivateDialog,
  PlanCreationDiscardDialog,
  PlanCreationDock,
} from "./PlanCreationCards";

const CHAT_DISCLAIMER =
  "Not medical advice, and not a substitute for a doctor or a certified coach.";
const COMPACT_CHAT_WIDTH = 900;

function FollowLatest(): null {
  const surface = useEnduragentStore((state) => state.chat);
  const appliedRevision = useRef(0);

  useLayoutEffect(() => {
    const hydrationChanged = surface.hydrationRevision !== appliedRevision.current;
    appliedRevision.current = surface.hydrationRevision;
    chatScrollAnchor.apply({ hydrationChanged, hydrationChange: surface.hydrationChange });
  });

  return null;
}

export function ChatView(): ReactElement {
  const surface = useRef<HTMLElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const composerDraft = useRef("");
  const [contextOpen, setContextOpen] = useState(true);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [decisionCustomOpen, setDecisionCustomOpen] = useState(false);
  const [planCreationEditorOpen, setPlanCreationEditorOpen] = useState(false);
  const activeView = useEnduragentStore((state) => state.activeView);
  const status = useEnduragentStore((state) => state.chat.status);
  const announcement = useEnduragentStore((state) => state.chat.announcement);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const planningRequestFocusId = useEnduragentStore((state) => state.chat.planningRequestFocusId);
  const actions = useEnduragentStore((state) => state.chatActions);
  const changeSurfaceVisible = useEnduragentStore((state) => {
    const library = state.planLibrary.value;
    return (
      library?.active !== null &&
      library?.active !== undefined &&
      ((state.planChange.open && state.planChange.planId === library.active.planId) ||
        library.changes.some((change) => change.status === "pending"))
    );
  });
  const mountedView = useRef(activeView);

  useLayoutEffect(() => {
    chatScrollAnchor.attach(conversation.current);
    return () => {
      chatScrollAnchor.attach(null);
    };
  }, []);

  useEffect(() => {
    const host = surface.current;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      const nextCompact = width <= COMPACT_CHAT_WIDTH;
      setCompact(nextCompact);
      if (!nextCompact) setContextDrawerOpen(false);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (activeView !== "chat") return;
    chatScrollAnchor.reanchor();
  }, [activeView]);

  useLayoutEffect(() => {
    if (activeView !== "chat" || planningRequestFocusId === null) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-planning-request-id]")].find(
      (element) => element.dataset.planningRequestId === planningRequestFocusId,
    );
    if (target === undefined) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
    actions?.clearPlanningRequestFocus();
  }, [actions, activeView, planningRequestFocusId]);

  useEffect(() => {
    if (mountedView.current === "chat") composer.current?.focus();
  }, []);

  useEffect(() => {
    const target = conversation.current;
    if (target === null) return;
    const onScroll = (): void => {
      if (target.offsetParent === null) return;
      if (
        target.scrollTop <= CHAT_AUTO_LOAD_EARLIER_THRESHOLD &&
        hasEarlier &&
        hydrationStatus !== "loading" &&
        hydrationStatus !== "failed" &&
        !workBlocked
      ) {
        actions?.loadEarlier();
      }
    };
    target.addEventListener("scroll", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
    };
  }, [actions, hasEarlier, hydrationStatus, workBlocked]);

  const contextExpanded = compact ? contextDrawerOpen : contextOpen;
  const toggleContext = (): void => {
    if (compact) setContextDrawerOpen(true);
    else setContextOpen((open) => !open);
  };
  const setCustomDecisionOpen = useCallback((open: boolean): void => {
    setDecisionCustomOpen(open);
  }, []);
  const setPlanEditorOpen = useCallback((open: boolean): void => {
    setPlanCreationEditorOpen(open);
  }, []);

  return (
    <section
      ref={surface}
      className="chat-surface grid min-h-0 min-w-0 flex-1 grid-rows-[52px_minmax(0,1fr)] bg-bg"
    >
      <header className="flex items-center justify-between border-b border-line px-[calc(var(--inset)*3)] max-md:px-[calc(var(--inset)*2)]">
        <h1 className="m-0 text-sm font-semibold">Chat</h1>
        {compact ? (
          <Dialog open={contextDrawerOpen} onOpenChange={setContextDrawerOpen}>
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={contextExpanded ? "Hide training context" : "Show training context"}
                />
              }
            >
              <PanelRightOpen />
            </DialogTrigger>
            <DialogContent className="top-0 right-0 left-auto h-full max-h-none w-[min(320px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 content-start overflow-auto [scrollbar-width:none] rounded-none rounded-l-card border-y-0 border-r-0 p-0">
              <DialogTitle className="sr-only">Training context</DialogTitle>
              <DialogDescription className="sr-only">
                Training data available to Coach.
              </DialogDescription>
              <TrainingContextPanel className="h-full border-l-0 pt-12" />
            </DialogContent>
          </Dialog>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={contextExpanded ? "Hide training context" : "Show training context"}
            aria-expanded={contextExpanded}
            onClick={toggleContext}
          >
            {contextExpanded ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        )}
      </header>
      <div
        className={`chat-layout row-start-2 grid min-h-0 min-w-0 ${contextOpen && !compact ? "grid-cols-[minmax(0,1fr)_252px]" : "grid-cols-[minmax(0,1fr)]"}`}
      >
        <div className="chat-reading-column grid min-h-0 min-w-0 px-6 max-md:px-4 grid-rows-[minmax(0,1fr)_auto] has-[[data-parity='question.card']]:grid-rows-[minmax(calc(var(--ctl-h-lg)*4),1fr)_minmax(0,auto)]">
          <main
            className="conversation overflow-auto [scrollbar-width:none] pt-[calc(var(--inset)*4)] pb-row [overflow-anchor:none] max-md:pt-5.5"
            aria-label="Coaching conversation"
            data-chat-status={status}
            ref={conversation}
          >
            <div className="thread mx-auto w-full max-w-[720px]">
              <Transcript />
              <PlanChangeCards />
              <CoachProgress />
              <FirstSyncCard />
            </div>
          </main>
          <div className="composer-wrap z-2 mx-auto grid w-full max-w-[720px] max-h-full min-h-0 grid-rows-[minmax(0,1fr)_auto_auto] overflow-hidden bg-bg bg-[linear-gradient(transparent,var(--bg)_22%)] pb-3.5">
            <div className="composer-projections min-h-0 overflow-y-auto [scrollbar-width:none] overscroll-contain empty:hidden">
              <div className="chat-notice-host empty:hidden">
                <p
                  className="new-conversation-status m-0 text-sm text-ink-2 not-empty:px-3.5 not-empty:pb-inset"
                  role="status"
                  aria-live="polite"
                >
                  {announcement ?? ""}
                </p>
                <SpendNotice />
                <Notice />
                <RetryBar />
              </div>
              <div className="mb-row grid gap-row empty:hidden">
                <CoachDecisionPanel onCustomOpenChange={setCustomDecisionOpen} />
                <PlanCreationDock onEditorOpenChange={setPlanEditorOpen} />
              </div>
              <AttachmentPanel />
              <QueuedMessages />
            </div>
            {decisionCustomOpen || planCreationEditorOpen ? null : (
              <Composer handle={composer} draftMemory={composerDraft} />
            )}
            <p className="mt-inset mb-0 text-center text-xs text-ink-3 max-md:hidden">
              {changeSurfaceVisible ? "Training changes need your confirmation." : CHAT_DISCLAIMER}
            </p>
          </div>
        </div>
        {contextOpen && !compact ? <TrainingContextPanel /> : null}
      </div>
      <NewConversationDialog
        onComposerReset={() => {
          composer.current?.reset();
        }}
      />
      <PlanCreationDiscardDialog />
      <PlanCreationActivateDialog />
      <FollowLatest />
    </section>
  );
}

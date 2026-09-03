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
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
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
import { PlanCreationDock } from "./PlanCreationCards";

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
  const [contextOpen, setContextOpen] = useState(true);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [decisionCustomOpen, setDecisionCustomOpen] = useState(false);
  const activeView = useEnduragentStore((state) => state.activeView);
  const status = useEnduragentStore((state) => state.chat.status);
  const announcement = useEnduragentStore((state) => state.chat.announcement);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const planningRequestFocusId = useEnduragentStore((state) => state.chat.planningRequestFocusId);
  const actions = useEnduragentStore((state) => state.chatActions);
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

  return (
    <section
      ref={surface}
      className="chat-surface grid min-h-0 min-w-0 flex-1 grid-rows-[52px_minmax(0,1fr)] bg-bg"
    >
      <header className="flex items-center justify-between border-b border-line px-[calc(var(--inset)*3)] max-[760px]:px-[calc(var(--inset)*2)]">
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
            <DialogContent className="top-0 right-0 left-auto h-full max-h-none w-[min(320px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 content-start overflow-auto rounded-none rounded-l-card border-y-0 border-r-0 p-0">
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
        className={`chat-layout row-start-2 grid min-h-0 min-w-0 ${contextOpen && !compact ? "grid-cols-[minmax(0,1fr)_300px]" : "grid-cols-[minmax(0,1fr)]"}`}
      >
        <div className="chat-reading-column grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
          <main
            className="conversation overflow-auto pt-[calc(var(--inset)*4)] pb-[calc(var(--inset)*3)] [overflow-anchor:none] max-[760px]:pt-[calc(var(--inset)*3)]"
            aria-label="Coaching conversation"
            data-chat-status={status}
            ref={conversation}
          >
            <div className="thread mx-auto w-[min(720px,calc(100%-48px))] max-[760px]:w-[calc(100%-32px)]">
              <Transcript />
              <CoachProgress />
              <FirstSyncCard />
            </div>
          </main>
          <div className="composer-wrap z-2 grid max-h-full min-h-0 grid-rows-[minmax(0,1fr)_auto_auto] overflow-hidden bg-bg bg-[linear-gradient(transparent,var(--bg)_22%)] px-[max(24px,calc((100%-720px)/2))] pt-[calc(var(--inset)*3)] pb-row max-[760px]:px-[calc(var(--inset)*2)]">
            <div className="composer-projections min-h-0 overflow-y-auto overscroll-contain empty:hidden">
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
              <div className="mb-2.5 grid gap-2.5 empty:hidden">
                <CoachDecisionPanel onCustomOpenChange={setCustomDecisionOpen} />
                <PlanCreationDock />
              </div>
              <AttachmentPanel />
              <QueuedMessages />
            </div>
            <Composer handle={composer} hidden={decisionCustomOpen} />
            <p className="mt-inset mb-0 text-center text-xs text-ink-3">{CHAT_DISCLAIMER}</p>
          </div>
        </div>
        {contextOpen && !compact ? <TrainingContextPanel /> : null}
      </div>
      <NewConversationDialog
        onComposerReset={() => {
          composer.current?.reset();
        }}
      />
      <FollowLatest />
    </section>
  );
}

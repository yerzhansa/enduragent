import { chatFeedbackMessage } from "./copy";
import { usePhrasebook } from "@enduragent/i18n/react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { CHAT_AUTO_LOAD_EARLIER_THRESHOLD, chatScrollAnchor } from "../../state/chat-stream";
import {
  planChangeOpenForActivePlan,
  planChangePendingCheck,
  planChangePendingInLibrary,
} from "../../state/chat-slice";
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
import { ConversationTimeline } from "./ConversationTimeline";
import { NewConversationDialog } from "./NewConversationDialog";
import { Notice } from "./Notice";
import { QueuedMessages } from "./QueuedMessages";
import { SpendNotice } from "./SpendNotice";
import { TrainingContextPanel } from "./TrainingContextPanel";
import { PlanChangeNotice } from "./PlanChangeCards";
import { PlanCreationActivateDialog, PlanCreationDiscardDialog } from "./PlanCreationCards";
import { PlanCreationHeaderActions, PlanCreationSubtitle } from "./PlanCreationHeader";
import {
  compensateScrollTop,
  destinationScrollTop,
  pendingNavigations,
  sourceActionIsAbove,
  type PendingNavigation,
} from "./conversation-timeline";

const COMPACT_CHAT_WIDTH = 900;

function pendingElement(
  conversation: HTMLElement,
  part: "card" | "heading" | "source",
  key: PendingNavigation["key"],
): HTMLElement | null {
  return conversation.querySelector<HTMLElement>(`[data-pending-navigation-${part}="${key}"]`);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

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
  const { say } = usePhrasebook();
  const surface = useRef<HTMLElement>(null);
  const pinnedRow = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const composerDraft = useRef("");
  const [contextOpen, setContextOpen] = useState(true);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [decisionCustomOpen, setDecisionCustomOpen] = useState(false);
  const [planCreationEditorOpen, setPlanCreationEditorOpen] = useState(false);
  const [planChangeEditorOpen, setPlanChangeEditorOpen] = useState(false);
  const [visiblePendingKeys, setVisiblePendingKeys] = useState<readonly string[]>([]);
  const [navigatingKey, setNavigatingKey] = useState<PendingNavigation["key"] | null>(null);
  const activeView = useEnduragentStore((state) => state.activeView);
  const status = useEnduragentStore((state) => state.chat.status);
  const announcement = useEnduragentStore((state) => state.chat.announcement);
  const announcementMessage = announcement === null ? null : chatFeedbackMessage(announcement);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const planningRequestFocusId = useEnduragentStore((state) => state.chat.planningRequestFocusId);
  const planCreationFocusRequest = useEnduragentStore(
    (state) => state.chat.planCreationFocusRequest,
  );
  const actions = useEnduragentStore((state) => state.chatActions);
  const planCreation = useEnduragentStore((state) => state.chat.planCreation);
  const chatNotice = useEnduragentStore((state) => state.chat.notice);
  const retryOffered = useEnduragentStore(
    (state) => state.chat.interrupted && state.chat.retryRequired === null,
  );
  const decision = useEnduragentStore((state) => state.chat.decision);
  const planLibrary = useEnduragentStore((state) => state.planLibrary.value);
  const planChangeNotice = useEnduragentStore((state) => state.planChange.notice);
  const planChangeFocusRequest = useEnduragentStore((state) => state.planChange.focusRequest);
  const planChangeBusy = useEnduragentStore((state) => state.planChange.busy);
  const planChangeSurfaceEditorOpen = useEnduragentStore((state) => state.planChange.editorOpen);
  const planChangeCheckPending = useEnduragentStore(
    (state) => planChangePendingCheck(state.planChange, state.planLibrary.value) !== null,
  );
  const spendWarning = useEnduragentStore((state) => state.settings.spend.warning);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const changeSurfaceVisible = useEnduragentStore(
    (state) =>
      state.planLibrary.value?.active != null &&
      (planChangeOpenForActivePlan(state.planChange, state.planLibrary.value) ||
        planChangePendingInLibrary(state.planLibrary.value)),
  );
  const mountedView = useRef(activeView);
  const previousConversationTop = useRef<number | null>(null);
  const pending = useMemo(
    () =>
      pendingNavigations({
        planCreation:
          planCreation === null
            ? null
            : { creationId: planCreation.creationId, hasDraft: planCreation.draft !== null },
        planChanges: planLibrary?.changes ?? [],
        decision,
      }),
    [decision, planCreation, planLibrary?.changes],
  );
  const visiblePending = pending.filter(
    (item) => visiblePendingKeys.includes(item.key) && item.key !== navigatingKey,
  );
  const hasPendingPlanChange = planChangePendingInLibrary(planLibrary);
  const planChangesPaused = planLibrary?.changesPaused != null;
  const persistentNoticeVisible =
    spendWarning !== null ||
    ((chatNotice !== null || retryOffered) && planCreation === null) ||
    (planLibrary?.active != null && (planChangesPaused || planChangeNotice !== null));
  const pinnedVisible = persistentNoticeVisible || visiblePending.length > 0;

  const updatePendingNavigation = useCallback((): void => {
    const target = conversation.current;
    if (target === null) return;
    const conversationTop = target.getBoundingClientRect().top;
    const next = pending
      .filter((item) => {
        if (item.key === navigatingKey) return false;
        const source = pendingElement(target, "source", item.key);
        const sourceRect = source?.getBoundingClientRect();
        return (
          source !== null &&
          sourceRect !== undefined &&
          !(
            source.getClientRects().length === 0 &&
            sourceRect.top === 0 &&
            sourceRect.bottom === 0
          ) &&
          sourceActionIsAbove(sourceRect.bottom, conversationTop)
        );
      })
      .map((item) => item.key);
    setVisiblePendingKeys((current) => (sameKeys(current, next) ? current : next));
  }, [navigatingKey, pending]);

  useLayoutEffect(() => {
    chatScrollAnchor.attach(conversation.current);
    return () => {
      chatScrollAnchor.attach(null);
    };
  }, []);

  useLayoutEffect(() => {
    if (activeView !== "chat") return;
    const target = conversation.current;
    if (target === null) return;
    const nextTop = target.getBoundingClientRect().top;
    const previousTop = previousConversationTop.current;
    if (previousTop !== null && previousTop !== nextTop) {
      target.scrollTop = compensateScrollTop(target.scrollTop, previousTop, nextTop);
    }
    previousConversationTop.current = nextTop;
  });

  useLayoutEffect(() => {
    updatePendingNavigation();
  }, [updatePendingNavigation]);

  useEffect(() => {
    const target = pinnedRow.current;
    if (target === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updatePendingNavigation();
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [updatePendingNavigation]);

  useLayoutEffect(() => {
    if (navigatingKey === null) return;
    const target = conversation.current;
    const card = target === null ? null : pendingElement(target, "card", navigatingKey);
    const heading = target === null ? null : pendingElement(target, "heading", navigatingKey);
    if (target !== null && card !== null && heading !== null) {
      heading.focus({ preventScroll: true });
      target.scrollTop = destinationScrollTop({
        scrollTop: target.scrollTop,
        cardTop: card.getBoundingClientRect().top,
        conversationTop: target.getBoundingClientRect().top,
      });
    }
    setNavigatingKey(null);
  }, [navigatingKey]);

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
    if (planCreationFocusRequest?.target !== "start") return;
    queueMicrotask(() => composer.current?.focus());
  }, [planCreationFocusRequest?.revision, planCreationFocusRequest?.target]);

  useEffect(() => {
    if (
      activeView !== "chat" ||
      planChangeFocusRequest?.target !== "change" ||
      planChangeBusy ||
      hasPendingPlanChange ||
      planChangeSurfaceEditorOpen ||
      planChangeCheckPending
    ) {
      return;
    }
    queueMicrotask(() => {
      if (planChangesPaused) document.getElementById("plan-changes-notice")?.focus();
      else composer.current?.focus();
    });
  }, [
    activeView,
    hasPendingPlanChange,
    planChangeBusy,
    planChangeFocusRequest?.revision,
    planChangeFocusRequest?.target,
    planChangeCheckPending,
    planChangeSurfaceEditorOpen,
    planChangesPaused,
  ]);

  useEffect(() => {
    const target = conversation.current;
    if (target === null) return;
    const onScroll = (): void => {
      updatePendingNavigation();
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
  }, [actions, hasEarlier, hydrationStatus, updatePendingNavigation, workBlocked]);

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
      <header className="flex min-w-0 items-center justify-between gap-4 border-b border-line px-[calc(var(--inset)*3)] max-md:px-[calc(var(--inset)*2)]">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="m-0 shrink-0 text-sm font-semibold">{say("chat.view.title")}</h1>
          <PlanCreationSubtitle />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PlanCreationHeaderActions />
          {planLibrary?.active == null ? null : (
            <Button type="button" variant="ghost" size="xs" onClick={() => setActiveView("plan")}>
              {say("chat.planChange.openPlan")}
            </Button>
          )}
          {compact ? (
            <Dialog open={contextDrawerOpen} onOpenChange={setContextDrawerOpen}>
              <DialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={
                      contextExpanded ? say("chat.view.hideContext") : say("chat.view.showContext")
                    }
                  />
                }
              >
                <PanelRightOpen />
              </DialogTrigger>
              <DialogContent className="top-0 right-0 left-auto h-full max-h-none w-[min(320px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 content-start overflow-auto [scrollbar-width:none] rounded-none rounded-l-card border-y-0 border-r-0 p-0">
                <DialogTitle className="sr-only">{say("chat.view.contextTitle")}</DialogTitle>
                <DialogDescription className="sr-only">
                  {say("chat.view.contextDetail")}
                </DialogDescription>
                <TrainingContextPanel className="h-full border-l-0 pt-12" />
              </DialogContent>
            </Dialog>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                contextExpanded ? say("chat.view.hideContext") : say("chat.view.showContext")
              }
              aria-expanded={contextExpanded}
              onClick={toggleContext}
            >
              {contextExpanded ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          )}
        </div>
      </header>
      <div
        className={`chat-layout grid min-h-0 min-w-0 ${contextOpen && !compact ? "grid-cols-[minmax(0,1fr)_252px]" : "grid-cols-[minmax(0,1fr)]"}`}
      >
        <div className="chat-reading-column grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] px-6 max-md:px-4">
          <div
            ref={pinnedRow}
            className="chat-pinned-row mx-auto grid w-full max-w-[720px] gap-inset py-inset"
            hidden={!pinnedVisible}
          >
            {spendWarning === null ? null : <SpendNotice />}
            {planCreation === null ? <Notice /> : null}
            {planLibrary?.active != null && (planChangesPaused || planChangeNotice !== null) ? (
              <PlanChangeNotice />
            ) : null}
            {visiblePending.map((item) => {
              const description =
                item.kind === "plan-creation"
                  ? say("chat.view.pendingDraft")
                  : item.kind === "plan-change"
                    ? say("chat.planChange.reviewNotice")
                    : say("chat.coachDecision.eyebrow");
              const action =
                item.kind === "plan-creation"
                  ? say("chat.view.reviewDraft")
                  : item.kind === "plan-change"
                    ? say("chat.view.reviewChange")
                    : say("chat.view.reviewChoices");
              return (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-inset rounded-ctl bg-surface-2 p-row"
                  role="status"
                >
                  <span className="text-xs leading-4 text-ink-2">{description}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setNavigatingKey(item.key)}
                  >
                    {action}
                  </Button>
                </div>
              );
            })}
          </div>
          <main
            className="conversation row-start-2 overflow-auto [scrollbar-width:none] pt-[calc(var(--inset)*4)] pb-row [overflow-anchor:none] max-md:pt-5.5"
            aria-label={say("chat.view.conversation")}
            data-chat-status={status}
            ref={conversation}
          >
            <div className="thread mx-auto grid w-full max-w-[720px] gap-7">
              <ConversationTimeline
                onDecisionEditorOpenChange={setCustomDecisionOpen}
                onPlanCreationEditorOpenChange={setPlanEditorOpen}
                onPlanChangeEditorOpenChange={setPlanChangeEditorOpen}
              />
            </div>
          </main>
          <div className="composer-wrap z-2 row-start-3 mx-auto grid max-h-full min-h-0 w-full max-w-[720px] grid-rows-[auto_auto_auto] bg-bg pb-3.5">
            <div className="composer-feedback empty:hidden">
              <div className="chat-notice-host empty:hidden">
                <p
                  className="new-conversation-status m-0 text-sm text-ink-2 not-empty:px-3.5 not-empty:pb-inset"
                  role="status"
                  aria-live="polite"
                >
                  {announcementMessage === null ? (announcement ?? "") : say(announcementMessage)}
                </p>
              </div>
            </div>
            <div className="composer-shell grid max-h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] rounded-card border border-line-2 bg-surface shadow-elev-2 transition-[border-color,box-shadow] duration-120 motion-reduce:transition-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
              <div className="composer-adjacent min-h-0 overflow-y-auto border-b border-line [scrollbar-width:none] overscroll-contain empty:hidden">
                <AttachmentPanel />
                <QueuedMessages />
              </div>
              {decisionCustomOpen || planCreationEditorOpen || planChangeEditorOpen ? null : (
                <Composer handle={composer} draftMemory={composerDraft} />
              )}
            </div>
            <p className="mt-inset mb-0 text-center text-xs text-ink-3 max-md:hidden">
              {changeSurfaceVisible ? say("chat.view.confirmation") : say("chat.view.disclaimer")}
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

---- MODULE WeekDelivery ----
\* Fill F1: which Training Weeks are on intervals.icu. Weeks 1..3; "now" is the week today is in.
\* Fixed = FALSE: the approved design read literally ("each week goes out 7 days before it
\* starts"). Fixed = TRUE: with the decisions.
EXTENDS Naturals
CONSTANT Fixed
Weeks == 1..3
VARIABLES now, sent, consent, weekly, okd, appOn, conn, stale
vars == <<now, sent, consent, weekly, okd, appOn, conn, stale>>

\* consent: "none" until the athlete approves the first Change Set at Save (Weeks 1 and 2).
\* weekly: the "Approve each week" setting. okd[w]: the athlete approved week w by itself.
\* stale: something changed since the last background run.

Init == /\ now = 1 /\ sent = [w \in Weeks |-> FALSE] /\ consent = "none"
        /\ weekly \in BOOLEAN /\ okd = [w \in Weeks |-> FALSE]
        /\ appOn = TRUE /\ conn = TRUE /\ stale = TRUE

Allowed(w) == consent = "given" /\ (w <= 2 \/ ~weekly \/ okd[w])
Due(w) == w <= now + 1                  \* 7 days before it starts, or later
\* Weeks the background run sends. Approved design read literally: Weeks 1 and 2 at Save,
\* then only the week that starts in 7 days. Fixed: every due week not on intervals.icu yet.
Sends(w) == /\ Allowed(w) /\ ~sent[w]
            /\ IF Fixed THEN w \in now..(now + 1) ELSE (w <= 2 \/ w = now + 1)

AppRuns ==
  /\ appOn /\ conn /\ stale
  /\ sent' = [w \in Weeks |-> sent[w] \/ Sends(w)]
  /\ stale' = FALSE
  /\ UNCHANGED <<now, consent, weekly, okd, appOn, conn>>
AWeekPasses == now < 3 /\ now' = now + 1 /\ stale' = TRUE /\ UNCHANGED <<sent, consent, weekly, okd, appOn, conn>>
YouApproveAtSave == consent = "none" /\ consent' = "given" /\ stale' = TRUE /\ UNCHANGED <<now, sent, weekly, okd, appOn, conn>>
YouApproveTheWeek ==
  /\ weekly /\ consent = "given"
  /\ \E w \in Weeks : w > 2 /\ Due(w) /\ ~okd[w] /\ okd' = [okd EXCEPT ![w] = TRUE]
  /\ stale' = TRUE /\ UNCHANGED <<now, sent, consent, weekly, appOn, conn>>
YouQuitOrStartTheApp == appOn' = ~appOn /\ stale' = TRUE /\ UNCHANGED <<now, sent, consent, weekly, okd, conn>>
ConnectionChanges == conn' = ~conn /\ stale' = TRUE /\ UNCHANGED <<now, sent, consent, weekly, okd, appOn>>
End == now = 3 /\ ~stale /\ UNCHANGED vars

Next == AppRuns \/ AWeekPasses \/ YouApproveAtSave \/ YouApproveTheWeek \/ YouQuitOrStartTheApp \/ ConnectionChanges \/ End

\* Rules.
NothingWithoutConsent == \A w \in Weeks : sent[w] => Allowed(w)
\* Whenever the app has run with a connection since the last change, this week and next are
\* on intervals.icu, unless the athlete chose to approve each week and has not approved one.
ThisWeekAndNextAreThere ==
  (appOn /\ conn /\ ~stale) => \A w \in Weeks : (w \in now..(now + 1) /\ Allowed(w)) => sent[w]
====

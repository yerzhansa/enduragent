import type { SpendRouteSummary, SpendSummary } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { currency, notionalSpendCopy, routeSpendCopy } from "../../state/adapters/spend";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

function localDateLabel(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1)));
}

function routeCache(route: SpendRouteSummary): string {
  if (route.cacheReadTokens === 0) return "No cache reads";
  if (route.cacheReadSavingsUsd === null) {
    return `${route.cacheReadTokens.toLocaleString("en-US")} cache-read tokens · savings unavailable`;
  }
  return `${route.cacheReadTokens.toLocaleString("en-US")} cache-read tokens · Saved ${currency(route.cacheReadSavingsUsd, true)}`;
}

function routeCaching(route: SpendRouteSummary): string {
  if (route.caching === "explicit") return "Explicit caching on this route.";
  if (route.caching === "provider-dependent") {
    return "Provider-dependent caching; no explicit breakpoint on this route.";
  }
  return route.disclosure ?? "";
}

function notices(summary: SpendSummary, stale: boolean): readonly string[] {
  const messages: string[] = [];
  if (!summary.spendComplete) {
    messages.push("Some provider costs are unavailable, so today’s total is a known minimum.");
  }
  if (summary.malformedLineCount > 0) messages.push("Some usage records could not be read.");
  const notional = notionalSpendCopy(summary);
  if (notional !== null) messages.push(notional);
  messages.push(
    `${summary.cacheSavingsComplete ? "Saved" : "Saved at least"} ${currency(summary.knownCacheReadSavingsUsd, true)} with cache reads`,
  );
  if (stale) messages.push("Spend data may be out of date.");
  return messages;
}

export function SpendSection(): ReactElement {
  const spend = useEnduragentStore((store) => store.settings.spend);
  const port = useEnduragentStore((store) => store.settingsPorts?.spend ?? null);
  const summary = spend.summary;
  const known =
    summary === null
      ? "—"
      : `${currency(summary.knownSpendUsd)}${summary.spendComplete ? "" : "+"}`;
  const cap = summary === null ? "—" : currency(summary.dailyCapUsd);

  return (
    <>
      <h2 className={styles.heading}>Spending</h2>
      <section
        className={styles.group}
        aria-label="Spending"
        data-spend-meter=""
        data-cap-status={summary?.capStatus}
      >
        <div className={`${styles.row} ${styles.rowStacked}`}>
          <div className={styles.bareRow}>
            <div className={styles.label}>
              <div className={styles.rowTitle}>
                {summary === null ? "Today" : `Today · ${localDateLabel(summary.localDate)}`}
              </div>
              <div className={styles.rowDetail}>
                {spend.status === "unavailable"
                  ? "Spend data unavailable."
                  : "Language model spend against today’s cap"}
              </div>
            </div>
            <strong className={styles.amount}>{`${known} / ${cap}`}</strong>
          </div>
          <progress
            className={styles.meter}
            aria-label="Daily spend cap"
            aria-valuetext={summary === null ? undefined : `${known} of ${cap}`}
            max={summary?.dailyCapUsd ?? 1}
            value={summary === null ? 0 : Math.min(summary.knownSpendUsd, summary.dailyCapUsd)}
          />
        </div>
        {summary === null
          ? null
          : notices(summary, spend.stale).map((message) => (
              <p key={message} className={styles.note}>
                {message}
              </p>
            ))}
        {summary === null || summary.routes.length === 0 ? null : (
          <div className={styles.routes} aria-label="Spend details">
            {summary.routes.map((route) => (
              <article key={`${route.provider}/${route.model}`} className={styles.route}>
                <p className={styles.routeHeading}>{`${route.provider} · ${route.model}`}</p>
                <p className={styles.routeDetail}>{routeSpendCopy(route)}</p>
                <p className={styles.routeDetail}>{routeCache(route)}</p>
                <p className={styles.routeDetail}>{routeCaching(route)}</p>
              </article>
            ))}
          </div>
        )}
        <div className={styles.capEditor}>
          <label className={styles.capLabel} htmlFor="daily-spend-cap">
            Daily cap (USD)
          </label>
          <input
            id="daily-spend-cap"
            type="number"
            step="any"
            inputMode="decimal"
            className={styles.control}
            value={spend.capDraft}
            onChange={(event) => {
              port?.changeCap(event.target.value);
            }}
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={spend.saving}
            onClick={() => {
              port?.save();
            }}
          >
            Save cap
          </Button>
          {spend.capError === null ? null : (
            <p className={`${styles.error} ${styles.capError}`} role="status">
              {spend.capError}
            </p>
          )}
        </div>
      </section>
    </>
  );
}

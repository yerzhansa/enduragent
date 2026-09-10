import { msg } from "@enduragent/i18n";
import type { SpendRouteSummary, SpendSummary } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { useEnduragentStore } from "../../state/store";
import { settingsStyles as styles } from "./styles";

function currency(
  value: number,
  { say, format }: Pick<Phrasebook, "say" | "format">,
  detail = false,
): string {
  if (value > 0 && value < 0.01 && !detail)
    return say("settings.spend.amountBelow", {
      amount: format.number(0.01, {
        useGrouping: false,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    });
  const digits = value > 0 && value < 0.01 && detail ? 4 : 2;
  return say("settings.spend.amount", {
    amount: format.number(Number(value.toFixed(digits)), {
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  });
}

function notionalSpendCopy(
  summary: SpendSummary,
  { say, format }: Pick<Phrasebook, "say" | "format">,
): string | null {
  const notional = summary.notionalSpendUsd ?? 0;
  return notional <= 0
    ? null
    : say("settings.spend.notional", { amount: currency(notional, { say, format }, true) });
}

function routeSpendCopy(route: SpendRouteSummary, { say, format }: Phrasebook): string {
  const notional = route.notionalSpendUsd ?? 0;
  const parts: string[] = [];
  if (notional === 0 || route.knownSpendUsd > 0)
    parts.push(currency(route.knownSpendUsd, { say, format }, true));
  if (notional > 0)
    parts.push(
      say("settings.spend.routeNotional", { amount: currency(notional, { say, format }, true) }),
    );
  parts.push(
    say("settings.spend.priced", {
      priced: format.number(route.pricedGenerationCount, { useGrouping: false }),
      total: format.number(route.generationCount, { useGrouping: false }),
    }),
  );
  return parts.join(" · ");
}

function localDateLabel(
  value: string,
  { say, format }: Pick<Phrasebook, "say" | "format">,
): string {
  const [, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1));
  const months = [
    msg("settings.spend.month.january"),
    msg("settings.spend.month.february"),
    msg("settings.spend.month.march"),
    msg("settings.spend.month.april"),
    msg("settings.spend.month.may"),
    msg("settings.spend.month.june"),
    msg("settings.spend.month.july"),
    msg("settings.spend.month.august"),
    msg("settings.spend.month.september"),
    msg("settings.spend.month.october"),
    msg("settings.spend.month.november"),
    msg("settings.spend.month.december"),
  ] as const;
  return say("settings.spend.date", {
    month: say(months[date.getUTCMonth()] ?? months[0]),
    day: format.date(date, { day: "numeric", timeZone: "UTC" }),
  });
}

function routeCache(route: SpendRouteSummary, { say, format }: Phrasebook): string {
  if (route.cacheReadTokens === 0) return say("settings.spend.cache.none");
  if (route.cacheReadSavingsUsd === null) {
    return say("settings.spend.cache.unknown", { tokens: format.number(route.cacheReadTokens) });
  }
  return say("settings.spend.cache.savings", {
    tokens: format.number(route.cacheReadTokens),
    amount: currency(route.cacheReadSavingsUsd, { say, format }, true),
  });
}

function routeCaching(route: SpendRouteSummary, say: Phrasebook["say"]): string {
  if (route.caching === "explicit") return say("settings.spend.cache.explicit");
  if (route.caching === "provider-dependent") {
    return say("settings.spend.cache.providerDependent");
  }
  return route.disclosure === null ? "" : say("settings.spend.cache.unavailable");
}

function notices(
  summary: SpendSummary,
  stale: boolean,
  { say, format }: Phrasebook,
): readonly string[] {
  const messages: string[] = [];
  if (!summary.spendComplete) {
    messages.push(say("settings.spend.notice.incomplete"));
  }
  if (summary.malformedLineCount > 0) messages.push(say("settings.spend.notice.malformed"));
  const notional = notionalSpendCopy(summary, { say, format });
  if (notional !== null) messages.push(notional);
  messages.push(
    summary.cacheSavingsComplete
      ? say("settings.spend.notice.saved", {
          amount: currency(summary.knownCacheReadSavingsUsd, { say, format }, true),
        })
      : say("settings.spend.notice.savedMinimum", {
          amount: currency(summary.knownCacheReadSavingsUsd, { say, format }, true),
        }),
  );
  if (stale) messages.push(say("settings.spend.notice.stale"));
  return messages;
}

export function SpendSection(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const spend = useEnduragentStore((store) => store.settings.spend);
  const port = useEnduragentStore((store) => store.settingsPorts?.spend ?? null);
  const summary = spend.summary;
  const known =
    summary === null
      ? "—"
      : summary.spendComplete
        ? currency(summary.knownSpendUsd, { say, format })
        : say("settings.spend.minimumAmount", {
            amount: currency(summary.knownSpendUsd, { say, format }),
          });
  const cap = summary === null ? "—" : currency(summary.dailyCapUsd, { say, format });

  return (
    <>
      <h2 className={styles.heading}>{say("settings.spend.title")}</h2>
      <section
        className={styles.group}
        aria-label={say("settings.spend.title")}
        data-spend-meter=""
        data-cap-status={summary?.capStatus}
      >
        <div className={`${styles.row} ${styles.rowStacked}`}>
          <div className={styles.bareRow}>
            <div className={styles.label}>
              <div className={styles.rowTitle}>
                {summary === null
                  ? say("settings.spend.today")
                  : say("settings.spend.todayDate", {
                      date: localDateLabel(summary.localDate, { say, format }),
                    })}
              </div>
              <div className={styles.rowDetail}>
                {spend.status === "unavailable"
                  ? say("settings.spend.unavailable")
                  : say("settings.spend.detail")}
              </div>
            </div>
            <strong className={styles.amount}>
              {say("settings.spend.amountAgainstCap", { known, cap })}
            </strong>
          </div>
          <progress
            className={styles.meter}
            aria-label={say("settings.spend.cap.aria")}
            aria-valuetext={
              summary === null ? undefined : say("settings.spend.cap.value", { known, cap })
            }
            max={summary?.dailyCapUsd ?? 1}
            value={summary === null ? 0 : Math.min(summary.knownSpendUsd, summary.dailyCapUsd)}
          />
        </div>
        {summary === null
          ? null
          : notices(summary, spend.stale, phrasebook).map((message) => (
              <p key={message} className={styles.note}>
                {message}
              </p>
            ))}
        {summary === null || summary.routes.length === 0 ? null : (
          <div className={styles.routes} aria-label={say("settings.spend.routes")}>
            {summary.routes.map((route) => (
              <article key={`${route.provider}/${route.model}`} className={styles.route}>
                <p className={styles.routeHeading}>{`${route.provider} · ${route.model}`}</p>
                <p className={styles.routeDetail}>{routeSpendCopy(route, phrasebook)}</p>
                <p className={styles.routeDetail}>{routeCache(route, phrasebook)}</p>
                <p className={styles.routeDetail}>{routeCaching(route, say)}</p>
              </article>
            ))}
          </div>
        )}
        <div className={styles.capEditor}>
          <label className={styles.capLabel} htmlFor="daily-spend-cap">
            {say("settings.spend.cap.label")}
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
            {say("settings.spend.cap.save")}
          </Button>
          {spend.capError === null ? null : (
            <p className={`${styles.error} ${styles.capError}`} role="status">
              {spend.capError === "Enter a daily cap greater than $0."
                ? say("settings.spend.cap.invalid")
                : say("settings.spend.cap.failed")}
            </p>
          )}
        </div>
      </section>
    </>
  );
}

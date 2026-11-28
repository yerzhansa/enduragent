import { z } from "zod";

export const CACHING_UNAVAILABLE_DISCLOSURE = "caching unavailable on this route" as const;

export const SpendCachingSchema = z.enum(["explicit", "provider-dependent", "unavailable"]);
export type SpendCaching = z.infer<typeof SpendCachingSchema>;

export const SpendCapStatusSchema = z.enum(["below", "reached", "unknown"]);
export type SpendCapStatus = z.infer<typeof SpendCapStatusSchema>;

export const SpendCapModeSchema = z.enum(["warn", "enforce"]);
export type SpendCapMode = z.infer<typeof SpendCapModeSchema>;

export const TurnRefusalSchema = z
  .object({
    kind: z.literal("spend-cap-reached"),
    dailyCapUsd: z.number().finite().positive(),
    knownSpendUsd: z.number().finite().nonnegative(),
  })
  .strict();
export type TurnRefusal = z.infer<typeof TurnRefusalSchema>;

export const SpendRouteSummarySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    generationCount: z.number().int().nonnegative(),
    pricedGenerationCount: z.number().int().nonnegative(),
    unpricedGenerationCount: z.number().int().nonnegative(),
    providerReportedGenerationCount: z.number().int().nonnegative(),
    knownSpendUsd: z.number().finite().nonnegative(),
    notionalSpendUsd: z.number().finite().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheReadSavingsUsd: z.number().finite().nonnegative().nullable(),
    caching: SpendCachingSchema,
    disclosure: z.literal(CACHING_UNAVAILABLE_DISCLOSURE).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pricedGenerationCount + value.unpricedGenerationCount !== value.generationCount) {
      context.addIssue({
        code: "custom",
        path: ["generationCount"],
        message: "route generation counts must balance",
      });
    }
    if (value.providerReportedGenerationCount > value.pricedGenerationCount) {
      context.addIssue({
        code: "custom",
        path: ["providerReportedGenerationCount"],
        message: "provider-reported generations must be priced",
      });
    }
    const unavailable = value.caching === "unavailable";
    const disclosed = value.disclosure === CACHING_UNAVAILABLE_DISCLOSURE;
    if (unavailable !== disclosed) {
      context.addIssue({
        code: "custom",
        path: ["disclosure"],
        message: "cache disclosure must match route availability",
      });
    }
  });
export type SpendRouteSummary = z.infer<typeof SpendRouteSummarySchema>;

export const SpendSummarySchema = z
  .object({
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    timezone: z.string().min(1),
    dailyCapUsd: z.number().finite().positive(),
    knownSpendUsd: z.number().finite().nonnegative(),
    notionalSpendUsd: z.number().finite().nonnegative().optional(),
    generationCount: z.number().int().nonnegative(),
    pricedGenerationCount: z.number().int().nonnegative(),
    unpricedGenerationCount: z.number().int().nonnegative(),
    malformedLineCount: z.number().int().nonnegative(),
    spendComplete: z.boolean(),
    capStatus: SpendCapStatusSchema,
    capMode: SpendCapModeSchema,
    cacheReadTokens: z.number().int().nonnegative(),
    knownCacheReadSavingsUsd: z.number().finite().nonnegative(),
    cacheSavingsComplete: z.boolean(),
    routes: z.array(SpendRouteSummarySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const generationCount = value.routes.reduce((sum, route) => sum + route.generationCount, 0);
    const pricedGenerationCount = value.routes.reduce(
      (sum, route) => sum + route.pricedGenerationCount,
      0,
    );
    const unpricedGenerationCount = value.routes.reduce(
      (sum, route) => sum + route.unpricedGenerationCount,
      0,
    );
    const knownSpendUsd = value.routes.reduce((sum, route) => sum + route.knownSpendUsd, 0);
    const notionalSpendUsd = value.routes.reduce(
      (sum, route) => sum + (route.notionalSpendUsd ?? 0),
      0,
    );
    const cacheReadTokens = value.routes.reduce((sum, route) => sum + route.cacheReadTokens, 0);
    const knownCacheReadSavingsUsd = value.routes.reduce(
      (sum, route) => sum + (route.cacheReadSavingsUsd ?? 0),
      0,
    );
    const cacheSavingsComplete =
      value.malformedLineCount === 0 &&
      value.routes.every((route) => route.cacheReadSavingsUsd !== null);
    const spendComplete = value.unpricedGenerationCount === 0 && value.malformedLineCount === 0;
    const capStatus =
      value.knownSpendUsd >= value.dailyCapUsd ? "reached" : spendComplete ? "below" : "unknown";
    const aggregateChecks: ReadonlyArray<readonly [boolean, string]> = [
      [
        value.pricedGenerationCount + value.unpricedGenerationCount === value.generationCount,
        "generation counts must balance",
      ],
      [value.generationCount === generationCount, "generation count must equal route totals"],
      [
        value.pricedGenerationCount === pricedGenerationCount,
        "priced generation count must equal route totals",
      ],
      [
        value.unpricedGenerationCount === unpricedGenerationCount,
        "unpriced generation count must equal route totals",
      ],
      [value.knownSpendUsd === knownSpendUsd, "known spend must equal route totals"],
      [
        (value.notionalSpendUsd ?? 0) === notionalSpendUsd,
        "notional spend must equal route totals",
      ],
      [value.cacheReadTokens === cacheReadTokens, "cache-read tokens must equal route totals"],
      [
        value.knownCacheReadSavingsUsd === knownCacheReadSavingsUsd,
        "known cache savings must equal route totals",
      ],
      [
        value.cacheSavingsComplete === cacheSavingsComplete,
        "cache savings completeness is inconsistent",
      ],
      [value.spendComplete === spendComplete, "spend completeness is inconsistent"],
      [value.capStatus === capStatus, "cap status is inconsistent"],
    ];
    for (const [valid, message] of aggregateChecks) {
      if (!valid) context.addIssue({ code: "custom", message });
    }
    for (let index = 0; index < value.routes.length; index += 1) {
      const route = value.routes[index];
      const previous = value.routes[index - 1];
      if (
        previous !== undefined &&
        (previous.provider.localeCompare(route.provider) > 0 ||
          (previous.provider === route.provider && previous.model.localeCompare(route.model) >= 0))
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", index],
          message: "routes must have unique sorted provider and model keys",
        });
      }
    }
  });
export type SpendSummary = z.infer<typeof SpendSummarySchema>;

export const GetSpendSummaryRpcParamsSchema = z.object({}).strict();
export type GetSpendSummaryRpcParams = z.infer<typeof GetSpendSummaryRpcParamsSchema>;

export const SetDailySpendCapRpcParamsSchema = z
  .object({ dailyCapUsd: z.number().finite().positive(), mode: SpendCapModeSchema.optional() })
  .strict();
export type SetDailySpendCapRpcParams = z.infer<typeof SetDailySpendCapRpcParamsSchema>;

export interface SpendOperations {
  getSpendSummary(request: GetSpendSummaryRpcParams): Promise<SpendSummary>;
  setDailySpendCap(request: SetDailySpendCapRpcParams): Promise<SpendSummary>;
}

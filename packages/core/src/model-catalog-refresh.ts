import { z } from "zod";
import { evaluateModelCatalogCandidate, type AcceptedModelCatalogRecord } from "./model-catalog.js";
import { ResponseLimitError } from "./model-catalog-http.js";

export const CatalogEtagSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    }),
  );

export type CatalogRefreshRetainReason =
  | "shutdown"
  | "request-failed"
  | "http-error"
  | "invalid-not-modified"
  | "invalid-response"
  | "response-too-large"
  | "no-usable-choices"
  | "stale-revision";

export type CatalogRefreshHeaderDecision =
  | {
      readonly kind: "retain";
      readonly reason: CatalogRefreshRetainReason;
      readonly cancelBody: true;
    }
  | { readonly kind: "not-modified"; readonly successfulAt: string }
  | { readonly kind: "read-body"; readonly etag: string; readonly successfulAt: string };

export type CatalogRefreshBodyDecision =
  | { readonly kind: "retain"; readonly reason: CatalogRefreshRetainReason }
  | { readonly kind: "updated"; readonly record: AcceptedModelCatalogRecord };

export type CatalogRefreshSession = {
  networkFailure(closed: boolean): CatalogRefreshRetainReason;
  bodyFailure(closed: boolean, error: unknown): CatalogRefreshRetainReason;
  fromHeaders(input: {
    readonly status: number;
    readonly responseEtag: string | null;
    readonly successfulAt: string | undefined;
  }): CatalogRefreshHeaderDecision;
  fromBody(input: {
    readonly closed: boolean;
    readonly body: string;
    readonly etag: string;
  }): CatalogRefreshBodyDecision;
};

export function createCatalogRefreshSession(input: {
  readonly requestEtag?: string;
  readonly current: AcceptedModelCatalogRecord;
}): CatalogRefreshSession {
  return {
    networkFailure(closed) {
      return closed ? "shutdown" : "request-failed";
    },
    bodyFailure(closed, error) {
      if (closed) return "shutdown";
      return error instanceof ResponseLimitError ? "response-too-large" : "request-failed";
    },
    fromHeaders({ status, responseEtag, successfulAt }) {
      if (status === 304) {
        if (
          input.requestEtag === undefined ||
          responseEtag !== input.requestEtag ||
          successfulAt === undefined
        ) {
          return { kind: "retain", reason: "invalid-not-modified", cancelBody: true };
        }
        return { kind: "not-modified", successfulAt };
      }
      if (status < 200 || status > 299) {
        return { kind: "retain", reason: "http-error", cancelBody: true };
      }
      const etag = CatalogEtagSchema.safeParse(responseEtag);
      if (!etag.success || successfulAt === undefined) {
        return { kind: "retain", reason: "invalid-response", cancelBody: true };
      }
      return { kind: "read-body", etag: etag.data, successfulAt };
    },
    fromBody({ closed, body, etag }) {
      if (closed) return { kind: "retain", reason: "shutdown" };
      let candidate: unknown;
      try {
        candidate = JSON.parse(body);
      } catch {
        return { kind: "retain", reason: "invalid-response" };
      }
      const evaluation = evaluateModelCatalogCandidate(candidate, etag, input.current);
      if (evaluation.kind === "retained") {
        return {
          kind: "retain",
          reason: evaluation.reason === "invalid" ? "invalid-response" : "no-usable-choices",
        };
      }
      if (evaluation.record.snapshot.revision <= input.current.snapshot.revision) {
        return { kind: "retain", reason: "stale-revision" };
      }
      return { kind: "updated", record: evaluation.record };
    },
  };
}

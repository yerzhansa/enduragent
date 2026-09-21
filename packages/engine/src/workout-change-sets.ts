import type { ToolRegistration } from "./sport.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PreparedChange =
  | {
      readonly kind: "add";
      readonly sport: "cycling" | "strength";
      readonly date: string;
      readonly name: string;
      readonly durationSeconds: number;
      readonly description: string;
      readonly effort: string;
      readonly structure: JsonValue | null;
      readonly reviewStructure?: JsonValue;
      readonly trainingLoad: number | null;
    }
  | {
      readonly kind: "edit";
      readonly eventId: number;
      readonly patch: WorkoutPatch;
      readonly reviewStructure?: JsonValue;
    }
  | { readonly kind: "delete"; readonly eventId: number };

export interface WorkoutPatch {
  readonly date?: string;
  readonly name?: string;
  readonly durationSeconds?: number;
  readonly description?: string;
  readonly trainingLoad?: number;
  readonly structure?: JsonValue;
}

export interface PendingSetReference {
  readonly setId: string;
  readonly revision: number;
}

export interface PendingWorkoutSnapshot {
  readonly eventId: number;
  readonly date: string;
  readonly name: string | null;
  readonly durationSeconds: number | null;
  readonly description: string | null;
  readonly trainingLoad: number | null;
  readonly structure: JsonValue | null;
}

export type PendingWorkoutItem =
  | { readonly id: string; readonly change: Extract<PreparedChange, { kind: "add" }> }
  | {
      readonly id: string;
      readonly change: Extract<PreparedChange, { kind: "edit" }>;
      readonly reviewed: PendingWorkoutSnapshot;
      readonly desired: PendingWorkoutSnapshot;
    }
  | {
      readonly id: string;
      readonly change: Extract<PreparedChange, { kind: "delete" }>;
      readonly reviewed: PendingWorkoutSnapshot;
    };

export type PendingWorkoutSet =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "pending";
      readonly reference: PendingSetReference;
      readonly changes: readonly PendingWorkoutItem[];
      readonly completedCount: number;
    };

export type Preparation =
  | { readonly kind: "complete"; readonly changes: readonly PreparedChange[] }
  | {
      readonly kind: "revise";
      readonly base: PendingSetReference;
      readonly replacements: readonly { readonly id: string; readonly change: PreparedChange }[];
    }
  | {
      readonly kind: "replace";
      readonly base: PendingSetReference;
      readonly changes: readonly PreparedChange[];
    }
  | { readonly kind: "incomplete"; readonly reason: string };

export type PreparationResult =
  | { readonly kind: "prepared"; readonly changeCount: number }
  | { readonly kind: "incomplete"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export interface WorkoutPreparationPort {
  readPending(input: { readonly chatId: string }): Promise<PendingWorkoutSet>;
  prepare(input: {
    readonly chatId: string;
    readonly turnId: string;
    readonly preparation: Preparation;
  }): Promise<PreparationResult>;
  settleTurn(input: {
    readonly chatId: string;
    readonly turnId: string;
    readonly outcome: "commit" | "abandon";
  }): Promise<void>;
}

export interface WorkoutPreparationCapability {
  readonly version: "aggregate-v1";
  readonly replacesTools: readonly string[];
  createTool(
    submit: (preparation: Preparation, options: unknown) => Promise<PreparationResult>,
  ): ToolRegistration;
}

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
      readonly trainingLoad: number | null;
    }
  | { readonly kind: "edit"; readonly eventId: number; readonly patch: WorkoutPatch }
  | { readonly kind: "delete"; readonly eventId: number };

export interface WorkoutPatch {
  readonly date?: string;
  readonly name?: string;
  readonly durationSeconds?: number;
  readonly description?: string;
  readonly trainingLoad?: number;
  readonly structure?: JsonValue;
}

export type Preparation =
  | { readonly kind: "complete"; readonly changes: readonly PreparedChange[] }
  | { readonly kind: "incomplete"; readonly reason: string };

export type PreparationResult =
  | { readonly kind: "prepared"; readonly changeCount: number }
  | { readonly kind: "incomplete"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export interface WorkoutPreparationPort {
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

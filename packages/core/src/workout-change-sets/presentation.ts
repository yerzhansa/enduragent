export type WorkoutChartUnit = "percent_ftp" | "watts" | "zone";

export type WorkoutChartSegment =
  | {
      readonly kind: "steady";
      readonly durationSeconds: number;
      readonly target: number;
    }
  | {
      readonly kind: "range";
      readonly durationSeconds: number;
      readonly low: number;
      readonly high: number;
    }
  | {
      readonly kind: "ramp";
      readonly durationSeconds: number;
      readonly start: number;
      readonly end: number;
    };

export interface WorkoutChartModel {
  readonly title: string;
  readonly subtitle: string;
  readonly axisLabel: string;
  readonly startLabel: string;
  readonly endLabel: string;
  readonly unit: WorkoutChartUnit;
  readonly durationSeconds: number;
  readonly segments: readonly WorkoutChartSegment[];
}

export type WorkoutCardBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

export interface WorkoutCardContent {
  readonly blocks: readonly WorkoutCardBlock[];
}

export type WorkoutReviewCard =
  | {
      readonly kind: "plot";
      readonly chart: WorkoutChartModel;
      readonly caption: WorkoutCardContent;
    }
  | {
      readonly kind: "text";
      readonly content: WorkoutCardContent;
    };

export interface WorkoutReviewDocument {
  readonly introduction: string;
  readonly cards: readonly WorkoutReviewCard[];
  readonly context: string;
  readonly summary: string;
}

export type WorkoutReviewPresentation =
  | { readonly kind: "text" }
  | { readonly kind: "cards"; readonly document: WorkoutReviewDocument };

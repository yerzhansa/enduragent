import type { ActivityAnalysisData, TrainingHistoryRide } from "@enduragent/coach-contract";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderLocalized as render } from "./language-harness";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import type { RideAnalysisViewState } from "../src/activity-analysis/controller";
import { RideDetailView } from "../src/ui/training/RideReview";

const ride: TrainingHistoryRide = {
  id: "a".repeat(64),
  title: null,
  subSport: "road",
  startEpochSeconds: 900_000_000,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-09",
  ridingSeconds: 3_500,
  ridingTimeBasis: "moving",
  elapsedSeconds: 3_600,
  distanceMeters: 32_000,
  load: null,
  averagePowerWatts: null,
  averageHeartRateBpm: null,
  perceivedExertion: null,
  energyKilojoules: null,
};

const fullMetrics = {
  movingSeconds: 300,
  elapsedSeconds: 305,
  averagePowerWatts: 250,
  maximumPowerWatts: 310,
  averageHeartRateBpm: 155,
  maximumHeartRateBpm: 170,
  averageCadenceRpm: 91,
  maximumCadenceRpm: 108,
  zone: 4,
  intensityPercent: 96.5,
  trainingLoad: 73.2,
} as const;

const emptyMetrics = {
  movingSeconds: 120,
  elapsedSeconds: 120,
  averagePowerWatts: null,
  maximumPowerWatts: null,
  averageHeartRateBpm: null,
  maximumHeartRateBpm: null,
  averageCadenceRpm: null,
  maximumCadenceRpm: null,
  zone: null,
  intensityPercent: null,
  trainingLoad: null,
} as const;

const intervalData = {
  source: "provider",
  intervals: [
    {
      ...fullMetrics,
      ordinal: 1,
      groupOrdinal: 1,
      kind: "work",
      label: "Threshold",
      startIndex: 0,
      endIndex: 299,
      startSeconds: 0,
      endSeconds: 300,
      distanceMeters: 2_500,
    },
    {
      ...emptyMetrics,
      ordinal: 2,
      groupOrdinal: 1,
      kind: "recovery",
      label: null,
      startIndex: 300,
      endIndex: 419,
      startSeconds: 300,
      endSeconds: 420,
      distanceMeters: null,
    },
  ],
  groups: [
    {
      ...fullMetrics,
      ordinal: 1,
      intervalOrdinals: [1, 2],
      kind: "unknown",
      averageCadenceRpm: 92,
      maximumCadenceRpm: 109,
      intensityPercent: 93,
      trainingLoad: 81,
    },
  ],
} as const satisfies ActivityAnalysisData["intervals"];

const analysis: RideAnalysisViewState = {
  activityId: ride.id,
  status: "ready",
  revision: "b".repeat(64),
  loadingSections: [],
  failedSections: [],
  sections: {
    intervals: {
      kind: "computed",
      data: intervalData,
      provenance: {
        source: "provider",
        delivery: "live",
        observedAt: "1998-07-19T08:00:00.000Z",
      },
    },
  },
};

describe("ride interval evidence", () => {
  it("shows complete interval and group metrics while keeping missing values unavailable", () => {
    render(
      <RideDetailView
        ride={ride}
        units="metric"
        analysis={analysis}
        calloutReason={null}
        onStartAnalysis={null}
        onRefreshAnalysis={null}
        onBack={() => undefined}
        titleRef={createRef<HTMLHeadingElement>()}
      />,
    );
    fireEvent.click(screen.getByText("Recorded analysis"));

    const ordered = screen.getByRole("list", {
      name: "Ordered ride intervals and laps",
    });
    const [work, recovery] = within(ordered).getAllByRole("listitem");
    expect(work).toHaveTextContent("91 avg · 108 max rpm");
    expect(work).toHaveTextContent("Zone 4");
    expect(work).toHaveTextContent("96.5%");
    expect(work).toHaveTextContent("73.2");

    const cadence = within(recovery!).getByText("Cadence").closest("div");
    const zone = within(recovery!).getByText("Zone").closest("div");
    const intensity = within(recovery!).getByText("Intensity").closest("div");
    const trainingLoad = within(recovery!).getByText("Training load").closest("div");
    for (const metric of [cadence, zone, intensity, trainingLoad]) {
      expect(metric).not.toBeNull();
      expect(within(metric!).getByLabelText("Unavailable")).toBeInTheDocument();
    }

    const groups = screen.getByRole("region", {
      name: "Interval group summaries",
    });
    expect(within(groups).getByText("Segment group")).toBeInTheDocument();
    expect(within(groups).getByText("Segments 1, 2")).toBeInTheDocument();
    expect(groups).toHaveTextContent("92 avg · 109 max rpm");
    expect(groups).toHaveTextContent("93%");
    expect(groups).toHaveTextContent("81");
  });
});

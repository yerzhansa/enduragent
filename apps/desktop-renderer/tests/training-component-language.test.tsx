import type { PowerProgressComputed, TrainingHistoryRide } from "@enduragent/coach-contract";
import { fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_RIDE_ANALYSIS } from "../src/activity-analysis/controller";
import { useEnduragentStore } from "../src/state/store";
import { PowerProgressContent } from "../src/ui/training/PowerProgressPanel";
import { RideDetailView } from "../src/ui/training/RideReview";
import { RideResponseReview } from "../src/ui/training/RideResponseReview";
import { WorkoutArchiveExportControl } from "../src/ui/training/TrainingExportControls";
import { renderWithCatalog } from "./language-harness";

const initialSettings = useEnduragentStore.getState().settings;

beforeEach(() => {
  useEnduragentStore.setState((state) => ({
    settings: {
      ...state.settings,
      language: { ...state.settings.language, status: "ready", value: "it" },
    },
  }));
});

afterEach(() => {
  useEnduragentStore.setState({ settings: initialSettings });
});

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
  distanceMeters: 32_500,
  load: null,
  averagePowerWatts: null,
  averageHeartRateBpm: null,
  perceivedExertion: null,
  energyKilojoules: null,
};

const progress: PowerProgressComputed = {
  kind: "computed",
  currentWindow: { start: "1998-06-22", end: "1998-07-19" },
  previousWindow: { start: "1998-05-25", end: "1998-06-21" },
  anchors: [
    {
      durationSeconds: 300,
      current: { kind: "computed", watts: 390 },
      previous: { kind: "computed", watts: 400 },
      change: { kind: "computed", percent: -2.5 },
    },
  ],
  rotation: "sprint",
  heartRateContext: { kind: "unavailable", reason: "insufficient-data" },
  sustainabilityContext: { kind: "unavailable", reason: "insufficient-data" },
  freshness: "fresh",
  asOf: "1998-07-19T08:00:00.000Z",
};

describe("training component phrasebooks", () => {
  it("reads ride review headings, kinds, and analysis labels from the supplied catalog", async () => {
    await renderWithCatalog(
      <RideDetailView
        ride={ride}
        units="metric"
        analysis={EMPTY_RIDE_ANALYSIS}
        calloutReason={null}
        onStartAnalysis={null}
        onRefreshAnalysis={null}
        onBack={() => undefined}
        titleRef={createRef<HTMLHeadingElement>()}
      />,
      {
        training: {
          view: { history: { review: "Analisi della corsa", disclosure: "Analisi registrata" } },
          ride: {
            kindRoad: "Corsa su strada",
            driftTitle: "Deriva aerobica locale",
            streamsLoading: "Verifica dei dati…",
          },
        },
      },
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Analisi della corsa" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Corsa su strada" })).toBeInTheDocument();
    expect(screen.getByText("32,5 km")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Analisi registrata"));
    expect(screen.getByRole("heading", { name: "Deriva aerobica locale" })).toBeInTheDocument();
    expect(screen.getByText("Verifica dei dati…")).toHaveAttribute("role", "status");
  });

  it("reads ride response headings and loading statuses from the supplied catalog", async () => {
    await renderWithCatalog(
      <RideResponseReview rideId={ride.id} analysis={EMPTY_RIDE_ANALYSIS} onRefresh={null} />,
      {
        training: {
          response: {
            powerDistributionTitle: "Distribuzione della potenza",
            distributionLoading: "Verifica di {{title}}…",
            responseTitle: "Risposta cardiaca alla potenza",
          },
        },
      },
    );
    expect(
      screen.getByRole("heading", { name: "Distribuzione della potenza" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Verifica di distribuzione della potenza…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.getByRole("heading", { name: "Risposta cardiaca alla potenza" }),
    ).toBeInTheDocument();
  });

  it("reads power progress table and accessibility copy from the supplied catalog", async () => {
    await renderWithCatalog(<PowerProgressContent panel={progress} />, {
      training: {
        power: {
          effort: "Sforzo",
          decreased: "Diminuita",
          changeLabel: "{{direction}} di {{value}}",
          rotation: { sprint: "Gli sforzi brevi sono migliorati." },
        },
      },
    });
    expect(screen.getByRole("columnheader", { name: "Sforzo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Diminuita di 2,5%")).toBeInTheDocument();
    expect(screen.getByText("Gli sforzi brevi sono migliorati.")).toBeInTheDocument();
  });

  it("reads workout export controls from the supplied catalog", async () => {
    await renderWithCatalog(
      <WorkoutArchiveExportControl oldest="1998-07-06" newest="1998-07-12" />,
      {
        training: {
          export: { formatLabel: "Formato allenamento", saveWorkouts: "Esporta allenamenti" },
        },
      },
    );
    expect(screen.getByRole("combobox", { name: "Formato allenamento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Esporta allenamenti" })).toBeInTheDocument();
  });
});

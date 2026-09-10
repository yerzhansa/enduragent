import { TRADEMARK_FORBIDDEN } from "../lib/needles.js";
import { EMPTY_SPORT_INFO, type S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

export const scenario: S8aScenario = {
  id: "turn-multistep-activities",
  tier: "replay",
  description: "Multi-step read turn: list recent rides, then pull one ride's full details.",
  intervals: {
    athlete: { ...STANDARD_ATHLETE },
    wellness: [
      { id: "1998-07-05", restingHR: 47, hrv: 71, sleepSecs: 27000, sportInfo: EMPTY_SPORT_INFO },
    ],
    activities: [
      {
        id: 90101,
        start_date_local: "1998-06-24T09:00:00",
        type: "Ride",
        name: "Endurance spin",
        moving_time: 5400,
        icu_training_load: 55,
      },
      {
        id: 90102,
        start_date_local: "1998-06-28T09:00:00",
        type: "Ride",
        name: "Hill repeats",
        moving_time: 4800,
        icu_training_load: 88,
      },
      {
        id: 90103,
        start_date_local: "1998-07-02T09:00:00",
        type: "Ride",
        name: "Long ride",
        moving_time: 10800,
        icu_training_load: 120,
      },
    ],
  },
  turns: [
    {
      chatId: "s8a-chat-1",
      userMessage:
        "List my rides from the last two weeks, then pull the full details of the hardest one and tell me what stands out.",
    },
  ],
  forbiddenNeedles: [...TRADEMARK_FORBIDDEN],
  recordExpectations: {
    tools: ["intervals_fetch_activities", "intervals_fetch_activity"],
    callers: ["chat"],
  },
};

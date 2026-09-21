export const coachingCases = {
  remember: { request: 'Remember that I prefer morning training.', calls: [{ name: 'memory_write', args: { type: 'memory', section: 'preferences', content: 'I prefer morning training.' } }] },
  correct: { request: 'Correct my preference to evening training.', calls: [{ name: 'memory_write', args: { type: 'memory', section: 'preferences', content: 'I prefer evening training.' } }] },
  note: { request: 'Save a daily note that the fictional easy ride felt comfortable.', calls: [{ name: 'memory_write', args: { type: 'daily', content: 'The fictional easy ride felt comfortable.' } }] },
  event: { request: 'Record my decision on 1998-09-07 to train in the evening because of my schedule.', calls: [{ name: 'ledger_append', args: { date: '1998-09-07', kind: 'decision', text: 'Train in the evening because of my schedule.' } }] },
  recall: { request: 'Recall my notes and decisions from 1998-09-07 through 1998-09-07.', calls: [{ name: 'memory_query', args: { from: '1998-09-07', to: '1998-09-07' } }] },
  storedNote: { request: 'Remember a general note that my fictional bicycle is blue.', calls: [{ name: 'memory_write', args: { type: 'memory', section: 'notes', content: 'My fictional bicycle is blue.' } }] },
  context: { request: 'Read my saved general notes and current plan.', calls: [{ name: 'memory_read', args: {} }, { name: 'plan_load', args: {} }] },
  profile: { request: 'Show my recorded athlete profile and wellness for 1998-09-06 through 1998-09-07.', calls: [{ name: 'intervals_fetch_athlete', args: {} }, { name: 'intervals_fetch_wellness', args: { oldest: '1998-09-06', newest: '1998-09-07' } }] },
  brief: { request: 'Give a brief review of my recorded activities on 1998-09-06.', calls: [{ name: 'intervals_fetch_activities', args: { oldest: '1998-09-06', newest: '1998-09-06' } }] },
  deep: { request: 'Give a deep review of recorded activity 301, including its laps and stream statistics.', calls: [{ name: 'intervals_fetch_activity', args: { activityId: 301 } }, { name: 'intervals_fetch_streams', args: { activityId: 301, types: ['watts', 'heartrate', 'cadence', 'time', 'altitude'] } }] },
  numbers: { request: 'Show the recorded numbers for activity 301 again.', calls: [{ name: 'intervals_fetch_activity', args: { activityId: 301 } }] },
  zones: { request: 'Calculate my power zones at FTP 280 watts.', calls: [{ name: 'calculate_zones', args: { ftpWatts: 280 } }] },
  feasibility: { request: 'Assess a target of 300 watts from my current FTP of 280 watts, weight 70 kg, intermediate experience.', calls: [{ name: 'assess_feasibility', args: { currentFtp: 280, targetFtp: 300, currentWeightKg: 70, experienceLevel: 'intermediate' } }] },
  week: { request: 'Draft a low-volume fixed sample training week for Tuesday, Thursday, and Saturday, with Saturday as my key session.', calls: [{ name: 'get_sample_week', args: { volumeTier: 'low', scheduleType: 'fixed', availableDays: ['tue', 'thu', 'sat'], keySessionDay: 'sat', sessionsPerWeek: 3 } }] },
  draft: { request: 'Draft a general-fitness training plan for an intermediate cyclist with FTP 280 watts, weight 70 kg, low volume, and fixed Tuesday, Thursday, Saturday sessions. Do not save it yet.', calls: [{ name: 'build_plan_skeleton', args: { experienceLevel: 'intermediate', ftpWatts: 280, weightKg: 70, volumeTier: 'low', scheduleType: 'fixed', availableDays: ['tue', 'thu', 'sat'], keySessionDay: 'sat', sessionsPerWeek: 3, goalType: 'general', generalGoal: 'General fitness' } }] },
  save: { request: 'Save the complete general-fitness plan you just drafted as Fictional fitness plan. Ask me for confirmation.', calls: [{ name: 'plan_save', args: 'draft' }] },
  load: { request: 'Load my current saved training plan.', calls: [{ name: 'plan_load', args: {} }] },
};

export const coachingSequences = {
  memory: ['remember', 'correct', 'note', 'event', 'recall', 'storedNote', 'context'],
  data: ['profile', 'brief', 'deep', 'numbers'],
  planning: ['zones', 'feasibility', 'week', 'draft', 'save', 'load'],
};

export const athleteFixture = {
  profile: { id: '0', name: 'Fixture Athlete', timezone: 'UTC', icu_weight: 70, icu_resting_hr: 48, sport_settings: [{ types: ['Ride', 'VirtualRide'], ftp: 280, indoor_ftp: 275, max_hr: 185, lthr: 170 }] },
  wellness: [{ id: '1998-09-06', ctl: 42, atl: 48, weight: 70, restingHR: 48, hrv: 62, sleepSecs: 28800 }, { id: '1998-09-07', ctl: 43, atl: 47, weight: 70, restingHR: 47, hrv: 64, sleepSecs: 27000 }],
  activities: [{ id: '301', name: 'Fictional endurance ride', type: 'Ride', start_date_local: '1998-09-06T08:00:00', moving_time: 3600, elapsed_time: 3600, distance: 25000, icu_training_load: 40, icu_intensity: 65, average_watts: 182, icu_weighted_avg_watts: 190, average_heartrate: 135, max_heartrate: 150, icu_ftp: 280, total_elevation_gain: 120 }, { id: '302', name: 'Fictional transition run', type: 'Run', start_date_local: '1998-09-06T09:10:00', moving_time: 1200, elapsed_time: 1200, distance: 3000, average_heartrate: 140, max_heartrate: 155 }],
  laps: [{ lap: 1, start_index: 0, end_index: 1, moving_time: 1800, average_watts: 170, average_heartrate: 130 }, { lap: 2, start_index: 2, end_index: 3, moving_time: 1800, average_watts: 194, average_heartrate: 140 }],
  streams: [{ type: 'watts', data: [100, 200, 300, 200] }, { type: 'heartrate', data: [120, 130, 140, 150] }, { type: 'cadence', data: [80, 90, 100, 90] }, { type: 'time', data: [0, 1, 2, 3] }, { type: 'altitude', data: [100, 110, 120, 110] }],
};

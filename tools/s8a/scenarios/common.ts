// Shared scenario staging constants. Every scenario stages the SAME athlete:
// the parent pins the child's INTERVALS_ATHLETE_ID to this id, so the mock's
// athlete-scoped routes only match when the two agree.
export const S8A_ATHLETE_ID = "i9876543";

export const STANDARD_ATHLETE = {
  id: S8A_ATHLETE_ID,
  icu_ftp: 250,
  icu_max_hr: 185,
  icu_lthr: 152,
  icu_resting_hr: 47,
  icu_weight: 70,
};

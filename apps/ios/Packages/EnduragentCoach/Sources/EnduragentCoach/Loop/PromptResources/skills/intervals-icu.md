# intervals.icu Reference

## Key Metrics

### Fitness (Chronic Training Load)
- Rolling ~42-day exponentially weighted average of daily load
- Higher = more aerobically fit (adapted to training stress)
- Typical range: 30 (recreational) → 80+ (competitive) → 120+ (elite)
- Builds slowly (~1 point/week with consistent training)

### Fatigue (Acute Training Load)
- Rolling ~7-day exponentially weighted average of daily load
- Higher = more fatigued from recent training
- Spikes after hard blocks, drops during recovery
- Should periodically exceed fitness (training stimulus)

### Form (Training Stress Balance)
- Form = fitness - fatigue
- Positive: Fresh, recovered (good for racing, not enough training stimulus)
- Slightly negative (-10 to -20): Functional overreaching (optimal training zone)
- Very negative (< -30): Accumulated fatigue (need recovery)
- Race day target: +5 to +15

### Load (Training Stress)
- Quantifies how hard a single ride was
- Load = (duration × weighted avg power × intensity) / (FTP × 3600) × 100
- A 1-hour ride at FTP = 100 load
- Easy ride: 30-50, Hard interval session: 70-100, Long ride: 150-250

### Intensity
- Intensity = weighted avg power / FTP
- < 0.75: Recovery/endurance
- 0.75-0.85: Tempo
- 0.85-0.95: Sweet spot (named sub-range, not a numbered zone)
- 0.95-1.05: Threshold
- > 1.05: VO2max / anaerobic

### Weighted Average Power
- Smoothed power that accounts for variability — weights harder efforts more heavily
- Better represents physiological cost than plain average power
- Outdoor rides: weighted average power >> plain average power (variability)
- Indoor ERG: weighted average power ≈ plain average power

### VI (Variability Index)
- VI = weighted avg power / average power
- 1.0 = perfectly steady (indoor ERG)
- 1.05-1.1 = typical outdoor ride
- > 1.15 = highly variable (criterium, mountain ride)

## Power Curve Interpretation

Peak power at standard durations reveals athlete strengths:
- **5s**: Neuromuscular power (sprint) — good > 15 W/kg
- **1min**: Anaerobic capacity — good > 8 W/kg
- **5min**: VO2max — good > 5 W/kg
- **20min**: Threshold proxy — FTP ≈ 95% of 20min power
- **60min**: True threshold / FTP

### Athlete Type Identification
- High 5s/1min relative to 20min: Sprinter
- High 5min relative to 20min: Punchy/attackers
- High 20min/60min: Time trialist / climber
- Flat curve across durations: All-rounder

## Wellness Data

- **Weight**: Track trends, not daily fluctuations. 7-day moving average is useful.
- **HRV (Heart Rate Variability)**: Higher = more recovered. Track trend, not absolute values.
- **Resting HR**: Lower = better fitness. Elevated = fatigue/illness/stress.
- **Sleep**: Quality and duration. < 7h consistently = recovery deficit.

## Calendar / Events

### Pushing Workouts — use `intervals_create_workout`

- Ramps **require** `power.low` and `power.high` (the ramp bounds).
- Prefer `percent_ftp` for every serialized target — the head unit resolves a percent
  unambiguously. A bare zone integer resolves against the athlete's **configured** bands
  (the mainstream **7-zone** Coggan model by default: Z4 = Threshold, Z5 = VO2max), so a
  `Z<n>` token can render **one band** off. Sweet spot is a named sub-range (see Power
  Zone Reference for the band), not a numbered zone — serialize it as a `percent_ftp`
  range, never a bare integer.
- Ramps accept `percent_ftp`, `watts`, or `zone` bounds. Zone-kind ramps are translated at serialization to percent-of-FTP band centers (Z1→45%, Z2→65%, Z3→83%, Z4→98%, Z5→113%, Z6→136%, Z7→160% — e.g. `Z1-Z2` becomes `ramp 45-65%`), so the power chart always renders. Use explicit `percent_ftp` bounds when you want exact ramp endpoints.

### Example: Sweet Spot 3×15

```json
{
  "date": "2026-04-18",
  "workout": {
    "name": "Sweet Spot 3x15",
    "steps": [
      { "type": "warmup",   "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 50, "high": 65 } },
      {
        "type": "set", "repeat": 3,
        "interval": { "type": "interval", "duration": { "value": 15, "unit": "minutes" }, "power": { "kind": "percent_ftp", "low": 88, "high": 94 }, "cadence": { "low": 85, "high": 95 } },
        "recovery": { "type": "recovery", "duration": { "value":  4, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
      },
      { "type": "cooldown", "duration": { "value": 10, "unit": "minutes" }, "power": { "kind": "percent_ftp", "value": 50 } }
    ]
  }
}
```

### Athlete-facing narrative goes in chat, not the workout

The calendar description is steps-only. Write the "why", the feel cues, hydration notes, and any
coaching color in your **chat reply** to the athlete — never inside the tool call. The athlete
reads coaching in chat; the head unit reads steps from intervals.icu.

### On validation errors

If the tool returns `{ error: "invalid_workout", details: <msg> }`, the structured input failed
validation (e.g. ramp missing low/high, zone outside 1–7, power range inverted). Read the message,
fix the offending step, and retry.

### Auto-Sync
Workouts pushed to intervals.icu calendar automatically sync to:
- Garmin Connect (within minutes)
- Wahoo ELEMNT (if connected)
- This means athletes can see planned workouts on their head unit

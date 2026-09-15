# Periodization

## 5 Periodization Models

### Linear
Simplest progression. Best for beginners.
Base → Build → Peak. Gradually increasing intensity over weeks.

### Block
Concentrated loading. 3-4 week focused blocks.
Best for intermediate riders with race goals. Each block targets one energy system.

### Reverse Linear
High intensity first, build endurance later.
Best for short plans (< 8 weeks) or when time-crunched. Front-loads quality.

### Polarized
80/20 split: mostly easy + some very hard. Minimal moderate.
Best for advanced/elite riders with high volume. Evidence-based for experienced athletes.

### Pyramidal
Balanced progression with most volume at base.
Default/fallback model. Versatile for most athletes without specific needs.

## Model Selection Logic

Which model fits depends on experience, runway, and volume — tier-honest:

- **Beginner** → simplest linear progression (base, build, peak). Consistency
  matters more than model cleverness here.
- **Short runway** (a few weeks to a goal) → front-load quality with a
  reverse-linear / front-loaded shape.
- **Polarized** (mostly easy with a hard minority) is reserved for *experienced,
  high-volume* riders — the evidence-favored choice for THAT population, not a
  universal default to reach for with a time-crunched intermediate.
- **Intermediate with a race goal** → a block model, one energy system at a time.
- Otherwise → a balanced pyramidal shape is the versatile fallback.

`build_plan_skeleton` decides the actual model deterministically; your job is to
explain *why* it fits the athlete, not to re-run the selection by hand.

## Where the numbers come from

The periodized structure — phase boundaries, intensity distributions,
build:recovery cadence, volume multipliers, and taper length — is computed by the
`build_plan_skeleton` tool. Call it with the athlete's profile and narrate the
output; never invent these numbers in prose, because they live in one
deterministic place and drift the moment they're copied.

What stays your job is per-phase *emphasis*, which the tool doesn't fully surface:
training is aerobic-emphasis / polarized. Base and aerobic phases carry the most
volume with the easy share dominant; as the focus sharpens toward threshold and
VO2max the easy share drops and the hard share grows — but hard work stays the
minority. The taper holds intensity while cutting volume. Teach that directional
shift ("mostly easy, with the hard work the minority that grows as focus
sharpens") and let the tool supply the exact figures.

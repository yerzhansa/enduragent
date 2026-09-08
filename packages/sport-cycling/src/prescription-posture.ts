export type PrescriptionCapability<EnvelopeValues> =
  | Readonly<{
      envelopeAuthorship: "unauthored";
      autonomousWorkoutProposals: "unavailable";
      envelopeValues: null;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>
  | Readonly<{
      envelopeAuthorship: "authored";
      autonomousWorkoutProposals: "available";
      envelopeValues: EnvelopeValues;
      promptSkillKey: string;
      toolSelectionRule: string;
    }>;

export const CYCLING_PRESCRIPTION_CAPABILITY = {
  envelopeAuthorship: "unauthored",
  autonomousWorkoutProposals: "unavailable",
  envelopeValues: null,
  promptSkillKey: "cycling-prescription-posture",
  toolSelectionRule:
    "Call this only when the current message explicitly asks for it; see the Cycling Prescription Availability skill.",
} as const satisfies PrescriptionCapability<never>;

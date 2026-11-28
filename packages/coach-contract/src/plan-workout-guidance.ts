const CORRECT_FTP_GUIDANCE = /^Use your confirmed FTP of \d{1,4} W$/u;

export function shownWorkoutGuidance(guidance: string): string | null {
  return CORRECT_FTP_GUIDANCE.test(guidance.trim()) ? null : guidance;
}

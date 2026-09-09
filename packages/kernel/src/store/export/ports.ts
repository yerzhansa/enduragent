export const PBKDF2_ITERATIONS = 600_000 as const;
export const PBKDF2_HASH = "SHA-256" as const;
export const SALT_BYTES = 16 as const;
export const NONCE_BYTES = 12 as const;
export const AES_KEY_BITS = 256 as const;

export interface ExportCryptoPort {
  /** Cryptographically-random bytes. */
  randomBytes(n: number): Uint8Array;
  /** PBKDF2(SHA-256, iterations) → AES-256-GCM encrypt. Returns ciphertext||tag. */
  encrypt(input: {
    readonly passphrase: string;
    readonly salt: Uint8Array;
    readonly iterations: number;
    readonly nonce: Uint8Array;
    readonly aad: Uint8Array;
    readonly plaintext: Uint8Array;
  }): Promise<Uint8Array>;
  /** Reverse of encrypt. MUST reject (throw) on any authentication failure
   *  (wrong passphrase OR modified bytes — AES-GCM cannot distinguish them). */
  decrypt(input: {
    readonly passphrase: string;
    readonly salt: Uint8Array;
    readonly iterations: number;
    readonly nonce: Uint8Array;
    readonly aad: Uint8Array;
    readonly ciphertext: Uint8Array;
  }): Promise<Uint8Array>;
}

export interface TextCodec {
  encodeUtf8(s: string): Uint8Array;
  decodeUtf8(b: Uint8Array): string;
}

export interface ArchiveArtifact {
  readonly address: string;
  readonly relPath: string;
  readonly bytes: number;
  readonly kind: string;
}

export type AuthoredRow = Record<string, unknown>;

export interface ExportSource {
  /** The store's current PRAGMA user_version at export time. */
  readUserVersion(): Promise<number>;
  /** Rows of one authored-class table. For a mixed table, opts.manualOnly
   *  is true and the source MUST return only provenance='manual' rows. Rows
   *  MUST be JSON-serializable (the adapter normalizes any bigint columns). */
  readAuthoredTable(
    table: string,
    opts: { readonly manualOnly: boolean },
  ): Promise<readonly AuthoredRow[]>;
}

export interface ArchiveManifestReader {
  /** Every raw-archive artifact as address+metadata; NO blob bytes. */
  listArtifacts(): Promise<readonly ArchiveArtifact[]>;
}

export interface RestoreTableResult {
  readonly table: string;
  readonly inserted: number;
  readonly skipped: number;
}

export interface RestoreTableOptions {
  readonly sourceUserVersion: number;
}

export interface ImportSink {
  /** Idempotent insert-if-absent by the table's primary key. Re-importing
   *  the same container inserts zero duplicate rows (skipped counts them). */
  restoreAuthoredTable(
    table: string,
    rows: readonly AuthoredRow[],
    options: RestoreTableOptions,
  ): Promise<RestoreTableResult>;
}

export interface ArchivePresenceChecker {
  /** True iff an artifact with this content address exists in the archive. */
  hasArtifact(address: string): Promise<boolean>;
}

export const PURE_AUTHORED_TABLES = [
  "athlete",
  "sport_settings",
  "race_goal",
  "intake_flags",
  "stroke_correction_overlay",
  "field_merge_override_overlay",
  "pool_size_correction_overlay",
  "dedup_confirmation",
  "chat_plan_outbox",
  "plan",
  "plan_reconciliation_job",
  "planning_authority",
  "planning_plan",
  "plan_revision",
  "plan_creation",
  "plan_creation_answer",
  "plan_creation_draft_revision",
  "athlete_preference",
  "training_restriction",
  "plan_change",
  "planning_command",
  "plan_adaptation_ledger",
  "plan_conversation",
  "plan_conversation_turn",
  "plan_draft_revision",
  "plan_intake",
  "plan_draft_build_checkpoint",
  "plan_proposal",
  "plan_proposal_premise",
  "plan_race_outcome",
  "plan_replacement",
  "plan_settings",
  "plan_source_request",
  "plan_workout",
  "plan_workout_drift",
  "plan_workout_match",
  "plan_weekly_review",
  "planning_request",
  "planning_request_terminal_result",
  "planning_request_tombstone",
] as const;

/** Mixed source|authored tables — ONLY provenance='manual' rows are authored. */
export const MIXED_AUTHORED_TABLES = [
  "anchor_history",
  "zone_set_history",
  "wellness",
  "planned_workout",
] as const;

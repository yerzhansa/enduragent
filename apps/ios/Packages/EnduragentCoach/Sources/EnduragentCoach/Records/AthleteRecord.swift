import Foundation

public enum RecordLocality: Sendable, Equatable {
	case synced
	case deviceLocal
}

public enum RecordKind: String, Sendable {
	case userMessage
	case assistantMessage
	case windowStart
	case compactionSummary
	case memorySection
	case dailyNote
	case ledgerEvent
	case journal
	case provenance
	case pendingProposal
	case proposalCleared
	case flushPending
	case coachReplyLanguage
	case planningDevice
	case planningCommand
	case planRevision
	case mirrorJob
	case workoutMatch
	case workoutDrift

	public var locality: RecordLocality {
		switch self {
		case .userMessage, .assistantMessage, .windowStart, .compactionSummary,
		     .memorySection, .dailyNote, .ledgerEvent, .journal, .provenance,
		     .coachReplyLanguage, .planningDevice:
			return .synced
		case .pendingProposal, .proposalCleared, .flushPending, .planningCommand,
		     .planRevision, .mirrorJob, .workoutMatch, .workoutDrift:
			return .deviceLocal
		}
	}
}

public enum RecordBody: Sendable, Equatable {
	case userMessage(UserMessageBody)
	case assistantMessage(AssistantMessageBody)
	case windowStart(WindowStartBody)
	case compactionSummary(CompactionSummaryBody)
	case memorySection(MemorySectionBody)
	case dailyNote(DailyNoteBody)
	case ledgerEvent(LedgerEventBody)
	case journal(JournalBody)
	case provenance(ProvenanceBody)
	case pendingProposal(ProposalBody)
	case proposalCleared(ProposalClearedBody)
	case flushPending(FlushPendingBody)
	case coachReplyLanguage(CoachReplyLanguageBody)
	case planningDevice(PlanningDeviceBody)
	case planningCommand(PlanningCommandBody)
	case planRevision(PlanRevisionBody)
	case mirrorJob(MirrorJobBody)
	case workoutMatch(WorkoutMatchBody)
	case workoutDrift(WorkoutDriftBody)

	public var kind: RecordKind {
		switch self {
		case .userMessage: return .userMessage
		case .assistantMessage: return .assistantMessage
		case .windowStart: return .windowStart
		case .compactionSummary: return .compactionSummary
		case .memorySection: return .memorySection
		case .dailyNote: return .dailyNote
		case .ledgerEvent: return .ledgerEvent
		case .journal: return .journal
		case .provenance: return .provenance
		case .pendingProposal: return .pendingProposal
		case .proposalCleared: return .proposalCleared
		case .flushPending: return .flushPending
		case .coachReplyLanguage: return .coachReplyLanguage
		case .planningDevice: return .planningDevice
		case .planningCommand: return .planningCommand
		case .planRevision: return .planRevision
		case .mirrorJob: return .mirrorJob
		case .workoutMatch: return .workoutMatch
		case .workoutDrift: return .workoutDrift
		}
	}
}

public struct UserMessageBody: Sendable, Equatable {
	public var chatId: ChatID
	public var athleteText: String
	public var timedText: String
	public var slash: SlashCommand?
}

public struct AssistantMessageBody: Sendable, Equatable {
	public var chatId: ChatID
	public var text: String
	public var templateHash: String
	public var assembledHash: String
}

public struct WindowStartBody: Sendable, Equatable {
	public var chatId: ChatID
	public var firstIncludedUlid: ULID
}

public struct CompactionSummaryBody: Sendable, Equatable {
	public var chatId: ChatID
	public var markdown: String
}

public struct MemorySectionBody: Sendable, Equatable {
	public var name: SectionName
	public var content: String
}

public struct DailyNoteBody: Sendable, Equatable {
	public var note: String
}

public struct LedgerEventBody: Sendable, Equatable {
	public var kind: LedgerKind
	public var text: String
	public var source: LedgerSource
}

public struct JournalBody: Sendable, Equatable {
	public var op: JournalOp
	public var preview: String
}

public struct ProvenanceBody: Sendable, Equatable {
	public var key: String
	public var garmin: Bool
	public var nonGarmin: Bool
	public var unknown: Bool
	public var contentSha256: String
}

public struct ProposalBody: Sendable, Equatable {
	public var chatId: ChatID
	public var nonce: Nonce
	public var tool: GatedToolName
	public var toolInput: GatedToolInput
	public var summary: String
	public var description: String
	public var expiresAt: Date
}

public struct ProposalClearedBody: Sendable, Equatable {
	public var chatId: ChatID
	public var nonce: Nonce
	public var reason: ProposalClearReason
}

public enum ProposalClearReason: String, Sendable {
	case executed
	case replaced
	case expired
	case cancelled
}

public struct FlushPendingBody: Sendable, Equatable {
	public var chatId: ChatID
	public var trigger: FlushTrigger
	public var messageUlids: [ULID]
}

public struct CoachReplyLanguageBody: Sendable, Equatable {
	public var tag: LanguageTag?
}

public struct PlanningDeviceBody: Sendable, Equatable {
	public var planningDeviceId: DeviceID
	public var planUlid: ULID
	public var activatedAt: Date
}

public struct PlanningCommandBody: Sendable, Equatable {
	public var commandName: PlanningCommandName
	public var commandId: String
	public var requestDigest: String
	public var status: PlanningCommandStatus
	public var result: JSONValue?
}

public struct PlanRevisionBody: Sendable, Equatable {
	public var planUlid: ULID
	public var version: Int
	public var status: PlanStatus
	public var snapshot: JSONValue
}

public struct MirrorJobBody: Sendable, Equatable {
	public var planUlid: ULID
	public var kind: MirrorJobKind
	public var windowStart: DateKey
	public var windowEnd: DateKey
	public var failureCount: Int
}

public struct WorkoutMatchBody: Sendable, Equatable {
	public var planWorkoutId: ULID
	public var activityId: String
	public var decision: MatchDecision
}

public struct WorkoutDriftBody: Sendable, Equatable {
	public var planWorkoutId: ULID
	public var askedAt: Date
}

public struct AthleteRecord: Sendable, Equatable, Identifiable {
	public var id: ULID { ulid }
	public var ulid: ULID
	public var deviceId: DeviceID
	public var hlc: HybridLogicalClock
	public var timeZone: IANATimeZone
	public var civilDate: CivilDate
	public var body: RecordBody

	public var locality: RecordLocality { body.kind.locality }

	public init(
		ulid: ULID,
		deviceId: DeviceID,
		hlc: HybridLogicalClock,
		timeZone: IANATimeZone,
		civilDate: CivilDate,
		body: RecordBody
	) {
		self.ulid = ulid
		self.deviceId = deviceId
		self.hlc = hlc
		self.timeZone = timeZone
		self.civilDate = civilDate
		self.body = body
	}
}

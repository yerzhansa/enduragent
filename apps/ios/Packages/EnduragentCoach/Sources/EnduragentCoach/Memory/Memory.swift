import Foundation

public enum SectionName: String, Sendable {
	case person
	case schedule
	case goals
	case preferences
	case notes
	case medicalHistory = "medical-history"
	case cyclingProfile = "cycling-profile"
	case cyclingEquipment = "cycling-equipment"
	case cyclingHistory = "cycling-history"

	public var inject: Bool {
		switch self {
		case .notes, .cyclingEquipment, .cyclingHistory: return false
		case .person, .schedule, .goals, .preferences, .medicalHistory, .cyclingProfile: return true
		}
	}

	public static let cyclingEffective: [SectionName] = [
		.person, .schedule, .goals, .preferences, .notes, .medicalHistory,
		.cyclingProfile, .cyclingEquipment, .cyclingHistory,
	]
}

public enum LedgerKind: String, Sendable {
	case decision
	case override
	case illness
	case experiment
	case outcome
}

public enum LedgerSource: String, Sendable {
	case flush
	case chat
}

public enum JournalOp: String, Sendable {
	case writeSection = "write-section"
	case savePlan = "save-plan"
	case renameSections = "rename-sections"
}

public enum FlushTrigger: String, Sendable {
	case trim
	case preCompaction
	case overflow
	case explicitReset
	case staleReset
	case softThreshold
}

public struct MemoryHit: Sendable, Equatable {
	public var date: CivilDate
	public var kind: Kind
	public var text: String

	public enum Kind: Sendable, Equatable {
		case dailyNote
		case ledger(LedgerKind)
		case journal
	}
}

public struct MemoryView: Sendable, Equatable {
	public var sections: [String: String]
	public var todayNotes: String?
	public var planHeadline: PlanHeadline?
	public var orphanNames: [String]
}

public struct PlanHeadline: Sendable, Equatable {
	public var name: String
	public var primaryGoal: String?
	public var totalWeeks: Int?
	public var status: PlanStatus?
}

public struct Memory: Sendable {
	private let store: any RecordLog
	private let clock: any Clock

	public init(store: any RecordLog, clock: any Clock) {
		self.store = store
		self.clock = clock
	}

	public func query(from: CivilDate, to: CivilDate, contains: String?) async throws -> [MemoryHit] {
		_ = store
		_ = from
		_ = to
		_ = contains
		return []
	}

	public func context() async throws -> String {
		_ = store
		return ""
	}

	public func writeSection(_ name: SectionName, content: String, source: LedgerSource) async throws {
		fatalError("not implemented")
	}

	public func appendDailyNote(_ note: String) async throws {
		fatalError("not implemented")
	}

	public func appendEvent(date: CivilDate, kind: LedgerKind, text: String, source: LedgerSource) async throws -> Bool {
		fatalError("not implemented")
	}

	public func flush(trigger: FlushTrigger, chatId: ChatID, transport: any ModelTransport) async throws {
		_ = store
		_ = trigger
		_ = chatId
		_ = transport
		_ = clock
	}

	public func view() async throws -> MemoryView {
		_ = store
		return MemoryView(sections: [:], todayNotes: nil, planHeadline: nil, orphanNames: [])
	}
}

public enum MemoryQuery {
	public static let maxRangeDays = 366
	public static let maxResultChars = 20_000

	public static func render(_ hits: [MemoryHit], from: CivilDate, to: CivilDate) -> String {
		fatalError("not implemented")
	}
}

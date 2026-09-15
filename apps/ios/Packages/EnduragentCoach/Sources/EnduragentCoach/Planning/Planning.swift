import Foundation

public enum PlanningCommandName: String, Sendable {
	case creationStart = "plan_creation.start"
	case creationAnswer = "plan_creation.answer"
	case creationPreview = "plan_creation.preview"
	case creationActivate = "plan_creation.activate"
	case creationDiscard = "plan_creation.discard"
	case changePreview = "plan_change.preview"
	case changeApply = "plan_change.apply"
	case planClose = "plan.close"
}

public enum PlanningCommandStatus: String, Sendable {
	case pending
	case succeeded
	case conflict
	case failed
}

public enum PlanStatus: String, Sendable {
	case active
	case closed
}

public enum CreationStatus: String, Sendable {
	case inProgress = "in-progress"
	case review
	case activated
	case discarded
}

public enum MirrorJobKind: String, Sendable {
	case mirror
	case cleanup
}

public enum MatchDecision: String, Sendable {
	case suggested
	case confirmed
	case rejected
	case unpaired
}

public struct PlanningCommandRequest: Sendable, Equatable {
	public var name: PlanningCommandName
	public var commandId: String
	public var payload: JSONValue
	public var expectedVersion: Int?
}

public enum PlanningCommandResult: Sendable, Equatable {
	case applied(PlanningView)
	case replayed(PlanningView)
	case commandConflict
	case refused(String)
}

public struct PlanningView: Sendable, Equatable {
	public var access: Access
	public var unfinishedCreation: CreationSummary?
	public var activePlan: PlanHeadline?
	public var previewChange: PlanChangePreview?
	public var cards: [PlanCard]

	public enum Access: Sendable, Equatable {
		case owner
		case readOnly(planningDeviceId: DeviceID)
		case none
	}
}

public struct CreationSummary: Sendable, Equatable {
	public var id: ULID
	public var status: CreationStatus
	public var version: Int
}

public struct PlanChangePreview: Sendable, Equatable {
	public var changeId: ULID
	public var confidence: String
}

public enum PlanCard: Sendable, Equatable {
	case creation(CreationSummary)
	case activationConfirm(name: String, closesIncumbent: String?)
	case changePreview(PlanChangePreview)
	case readOnlyPlan(headline: PlanHeadline, planningDeviceId: DeviceID)
}

package struct PlanningAggregate: Sendable, Equatable {
	package var creation: CreationSummary?
	package var plan: PlanRevisionBody?
	package var previewChange: PlanChangePreview?
	package var commandLedger: [PlanningCommandBody]
	package var mirrorJobs: [MirrorJobBody]
}

public enum PlanningPolicy {
	public static let mirrorDays = 7
	public static let staleAfterHours = 24
	public static let raceWindowDays = 7
	public static let maxMirrorFailures = 5
	public static let drainLease: Duration = .seconds(300)
	public static let uidPrefix = "cycling-coach:plan:"
	public static let builderId = "cycling-creation-draft"
	public static let builderVersion = "1"
	public static let confidenceCopy =
		"Moderate confidence. Based on your confirmed limits and the available training record."

	public static func mirrorUID(plan: ULID, workout: ULID) -> PlanMirrorUID {
		PlanMirrorUID(planId: plan, workoutId: workout)
	}

	public static func mirrorWindow(today: DateKey) -> (DateKey, DateKey) {
		fatalError("not implemented")
	}

	package static func fold(_ records: [AthleteRecord]) -> PlanningAggregate {
		fatalError("not implemented")
	}
}

public actor Planning {
	private let store: any RecordLog
	private let intervals: any IntervalsClient
	private let clock: any Clock

	public init(store: any RecordLog, intervals: any IntervalsClient, clock: any Clock) {
		self.store = store
		self.intervals = intervals
		self.clock = clock
	}

	public func dispatch(_ request: PlanningCommandRequest) async throws -> PlanningCommandResult {
		fatalError("not implemented")
	}

	public func read() async throws -> PlanningView {
		fatalError("not implemented")
	}

	public func drainMirror(plan: ULID) async throws {
		fatalError("not implemented")
	}

	public func isPlanningDevice() async throws -> Bool {
		fatalError("not implemented")
	}
}

public enum CreationDraftBuilder {
	public static func build(answers: JSONValue, today: DateKey) throws -> JSONValue {
		fatalError("not implemented")
	}
}

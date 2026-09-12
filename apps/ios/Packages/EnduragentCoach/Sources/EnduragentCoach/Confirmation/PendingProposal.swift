import Foundation

public struct PendingProposal: Sendable, Equatable {
	public var chatId: ChatID
	public var nonce: Nonce
	public var summary: String
	public var description: String
	public var expiresAt: Date
}

public enum GatedToolInput: Sendable, Equatable {
	case createWorkout(date: CivilDate, workout: IntervalsWorkoutInput)
	case createStrengthWorkout(date: CivilDate, name: String, description: String)
	case deleteWorkout(eventId: EventID)
	case updateWorkout(UpdateWorkoutInput)
	case planSave(PlanHeadline)
}

public struct UpdateWorkoutInput: Sendable, Equatable {
	public var eventId: EventID
	public var date: CivilDate?
	public var name: String?
	public var description: String?
}

package enum ProposalLookup: Sendable, Equatable {
	case found(ProposalBody)
	case expired
	case mismatch
	case none
}

package enum ProposalPolicy {
	package static let ttl: Duration = TurnPolicy.proposalTTL

	package static func propose(
		chatId: ChatID,
		tool: GatedToolName,
		input: GatedToolInput,
		summary: String,
		description: String,
		now: Date,
		store: any RecordLog,
		clock: any Clock
	) async throws -> PendingProposal {
		fatalError("not implemented")
	}

	package static func take(
		chatId: ChatID,
		nonce: Nonce,
		store: any RecordLog,
		clock: any Clock,
		run: @Sendable (GatedToolInput) async throws -> JSONValue
	) async throws -> ProposalLookup {
		fatalError("not implemented")
	}
}

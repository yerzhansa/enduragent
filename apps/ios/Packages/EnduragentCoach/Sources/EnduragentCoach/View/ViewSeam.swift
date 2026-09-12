import Foundation
import Observation

public struct ViewSeam: Sendable, Equatable {
	public var transcript: [ChatMessage]
	public var streamingText: String
	public var leadFact: LeadFact?
	public var commands: [SlashCommand]
	public var pendingWrite: PendingProposal?
	public var planCards: [PlanCard]
	public var phase: TurnPhase

	public static let empty = ViewSeam(
		transcript: [],
		streamingText: "",
		leadFact: nil,
		commands: SlashCommand.all,
		pendingWrite: nil,
		planCards: [],
		phase: .idle
	)
}

public enum TurnPhase: Sendable, Equatable {
	case idle
	case streaming
	case awaitingConfirmation
	case failed(String)
}

public struct LeadFact: Sendable, Equatable {
	public var athleteFirstName: String
	public var date: CivilDate
	public var fitness: Double?
	public var fatigue: Double?
	public var form: Double?
}

@MainActor
@Observable
public final class CoachViewModel {
	public private(set) var seam: ViewSeam
	private let coach: Coach
	private let chatId: ChatID

	public init(coach: Coach, chatId: ChatID = .main) {
		self.coach = coach
		self.chatId = chatId
		self.seam = .empty
	}

	public func appear() async {
		fatalError("not implemented")
	}

	public func send(_ text: String) async {
		fatalError("not implemented")
	}

	public func confirmPending() async {
		fatalError("not implemented")
	}

	public func cancelPending() async {
		fatalError("not implemented")
	}

	public func setReplyLanguage(_ tag: LanguageTag?) async {
		fatalError("not implemented")
	}
}

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
	package static let ttlSeconds: TimeInterval = 10 * 60

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
		let records = try await store.fetch(
			RecordQuery(kinds: [.pendingProposal, .proposalCleared], chatId: chatId, deviceLocalOnly: true)
		)
		var last = records.map(\.hlc).max()
		if let live = UnionMerge.pendingProposal(records, chatId: chatId, now: now) {
			try await append(
				.proposalCleared(
					ProposalClearedBody(chatId: chatId, nonce: live.nonce, reason: .replaced)
				),
				store: store,
				clock: clock,
				last: &last
			)
		}
		let nonce = Nonce()
		let expiresAt = now.addingTimeInterval(ttlSeconds)
		let body = ProposalBody(
			chatId: chatId,
			nonce: nonce,
			tool: tool,
			toolInput: input,
			summary: summary,
			description: description,
			expiresAt: expiresAt
		)
		try await append(.pendingProposal(body), store: store, clock: clock, last: &last)
		return PendingProposal(
			chatId: chatId,
			nonce: nonce,
			summary: summary,
			description: description,
			expiresAt: expiresAt
		)
	}

	package static func take(
		chatId: ChatID,
		nonce: Nonce,
		store: any RecordLog,
		clock: any Clock,
		run: @Sendable (GatedToolInput) async throws -> JSONValue
	) async throws -> ProposalLookup {
		let records = try await store.fetch(
			RecordQuery(kinds: [.pendingProposal, .proposalCleared], chatId: chatId, deviceLocalOnly: true)
		)
		let now = clock.now
		if let live = UnionMerge.pendingProposal(records, chatId: chatId, now: now) {
			if live.nonce != nonce {
				return .mismatch
			}
			var last = records.map(\.hlc).max()
			try await append(
				.proposalCleared(
					ProposalClearedBody(chatId: chatId, nonce: nonce, reason: .executed)
				),
				store: store,
				clock: clock,
				last: &last
			)
			_ = try await run(live.toolInput)
			return .found(live)
		}
		if latestUncleared(records, chatId: chatId) != nil {
			return .expired
		}
		return .none
	}

	package static func summary(for input: GatedToolInput) -> String {
		switch input {
		case .createWorkout(let date, let workout):
			return "Create workout \"\(workout.name)\" on \(date.rawValue)"
		case .createStrengthWorkout(let date, let name, _):
			return "Create strength workout \"\(name)\" on \(date.rawValue)"
		case .deleteWorkout:
			return "Delete a workout"
		case .updateWorkout(let update):
			var fields: [String] = []
			if let date = update.date {
				fields.append("date to \(date.rawValue)")
			}
			if let name = update.name {
				fields.append("name to \"\(name)\"")
			}
			if update.description != nil {
				fields.append("description")
			}
			let detail = fields.isEmpty ? "selected fields" : fields.joined(separator: ", ")
			return "Update workout — \(detail)"
		case .planSave(let headline):
			if headline.name.isEmpty {
				return "Save the training plan — replaces the current saved plan"
			}
			return "Save the training plan — replaces the current saved plan — \(headline.name)"
		}
	}

	private static func latestUncleared(_ records: [AthleteRecord], chatId: ChatID) -> ProposalBody? {
		let ordered = records.sorted { $0.hlc < $1.hlc }
		var cleared: Set<Nonce> = []
		for record in ordered {
			if case .proposalCleared(let body) = record.body, body.chatId == chatId {
				cleared.insert(body.nonce)
			}
		}
		for record in ordered.reversed() {
			guard case .pendingProposal(let body) = record.body, body.chatId == chatId else { continue }
			if cleared.contains(body.nonce) { continue }
			return body
		}
		return nil
	}

	private static func append(
		_ body: RecordBody,
		store: any RecordLog,
		clock: any Clock,
		last: inout HybridLogicalClock?
	) async throws {
		let tz = IANATimeZone(identifier: clock.timeZone.identifier) ?? IANATimeZone(identifier: "GMT")!
		let record = AthleteRecord(
			ulid: ULID.generate(at: clock.now),
			deviceId: store.deviceId,
			hlc: .tick(now: clock.now, deviceId: store.deviceId, last: last),
			timeZone: tz,
			civilDate: IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone),
			body: body
		)
		last = record.hlc
		try await store.append(record)
	}
}

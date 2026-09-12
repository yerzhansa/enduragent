import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct ProposalPolicyTests {
	let store = InMemoryRecordLog()
	let clock = FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func expiredProposalAfterElevenMinutes() async throws {
		let proposal = try await propose()
		clock.advance(by: 11 * 60)
		let lookup = try await ProposalPolicy.take(
			chatId: .main,
			nonce: proposal.nonce,
			store: store,
			clock: clock,
			run: { _ in .object([:]) }
		)
		#expect(lookup == .expired)
	}

	@Test func wrongNonceIsMismatch() async throws {
		_ = try await propose()
		let lookup = try await ProposalPolicy.take(
			chatId: .main,
			nonce: Nonce(),
			store: store,
			clock: clock,
			run: { _ in .object([:]) }
		)
		#expect(lookup == .mismatch)
	}

	@Test func replacementClearsPreviousNonce() async throws {
		let first = try await propose(name: "One")
		let second = try await propose(name: "Two")
		let firstLookup = try await ProposalPolicy.take(
			chatId: .main,
			nonce: first.nonce,
			store: store,
			clock: clock,
			run: { _ in .object([:]) }
		)
		#expect(firstLookup == .mismatch)
		let secondLookup = try await ProposalPolicy.take(
			chatId: .main,
			nonce: second.nonce,
			store: store,
			clock: clock,
			run: { _ in .object(["created": .bool(true)]) }
		)
		guard case .found(let body) = secondLookup else {
			Issue.record("expected found")
			return
		}
		#expect(body.summary.contains("Two"))
	}

	@Test func secondTakeIsNone() async throws {
		let proposal = try await propose()
		_ = try await ProposalPolicy.take(
			chatId: .main,
			nonce: proposal.nonce,
			store: store,
			clock: clock,
			run: { _ in .object([:]) }
		)
		let again = try await ProposalPolicy.take(
			chatId: .main,
			nonce: proposal.nonce,
			store: store,
			clock: clock,
			run: { _ in .object([:]) }
		)
		#expect(again == .none)
	}

	private func propose(name: String = "Endurance") async throws -> PendingProposal {
		let workout = IntervalsWorkoutInput(
			name: name,
			steps: [
				.simple(
					SimpleStep(
						type: .warmup,
						duration: DurationInput(value: 10, unit: .minutes),
						power: PowerTarget(kind: .percentFtp, value: nil, low: 55, high: 65),
						cadence: nil,
						label: nil
					)
				),
			]
		)
		let input = GatedToolInput.createWorkout(date: "1998-06-14", workout: workout)
		return try await ProposalPolicy.propose(
			chatId: .main,
			tool: .intervalsCreateWorkout,
			input: input,
			summary: ProposalPolicy.summary(for: input),
			description: "Warmup\n- 10m 55-65%",
			now: clock.now,
			store: store,
			clock: clock
		)
	}
}

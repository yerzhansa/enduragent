import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct GatedToolsTests {
	let intervals = FakeIntervalsClient(athleteName: "Ada", ftp: 250)
	let clock = FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func createWorkoutReturnsPendingWithoutWriting() async throws {
		let outcome = try await runtime().execute(
			name: .intervalsCreateWorkout,
			arguments: try JSONValue.parse(enduranceArguments),
			chatId: .main,
			state: turnState()
		)
		guard case .pending(let proposal) = outcome else {
			Issue.record("expected pending")
			return
		}
		#expect(proposal.summary == "Create workout \"Endurance\" on 1998-06-14")
		#expect(proposal.description.hasPrefix("Warmup\n- 10m 55-65%"))
		#expect(
			!intervals.calls.contains { call in
				if case .createEvent = call { return true }
				return false
			}
		)
		let encoded = JSONValue.object([
			"pendingConfirmation": .bool(true),
			"summary": .string(proposal.summary),
		]).canonicalDigestInput()
		#expect(encoded.contains("pendingConfirmation"))
		#expect(!encoded.contains(proposal.nonce.rawValue.uuidString))
	}

	@Test func planSaveIsRefused() async throws {
		let outcome = try await runtime().execute(
			name: .planSave,
			arguments: try JSONValue.parse(#"{"plan":{"name":"Base"}}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let json) = outcome else {
			Issue.record("expected result")
			return
		}
		#expect(unwrapData(json).objectFields["error"]?.stringValue == "not_implemented")
		#expect(intervals.calls.isEmpty)
	}

	@Test func strengthDeleteAndUpdateAreGated() async throws {
		let tools = runtime()
		let strength = try await tools.execute(
			name: .intervalsCreateStrengthWorkout,
			arguments: try JSONValue.parse(
				#"{"date":"1998-06-14","name":"Core","description":"20 min floor"}"#
			),
			chatId: .main,
			state: turnState()
		)
		guard case .pending(let strengthProposal) = strength else {
			Issue.record("expected strength pending")
			return
		}
		#expect(strengthProposal.summary == "Create strength workout \"Core\" on 1998-06-14")

		let deleted = try await tools.execute(
			name: .intervalsDeleteWorkout,
			arguments: try JSONValue.parse(#"{"eventId":42}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .pending = deleted else {
			Issue.record("expected delete pending")
			return
		}

		let updated = try await tools.execute(
			name: .intervalsUpdateWorkout,
			arguments: try JSONValue.parse(#"{"eventId":42,"name":"Endurance 2"}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .pending = updated else {
			Issue.record("expected update pending")
			return
		}
		#expect(
			!intervals.calls.contains { call in
				switch call {
				case .createEvent, .updateEvent, .deleteEvent:
					return true
				default:
					return false
				}
			}
		)
	}

	@Test func rebuildConfirmedSerializesFromStoredInput() async throws {
		let workout = try IntervalsSerializer.parseWorkout(
			try JSONValue.parse(
				#"{"name":"Endurance","steps":[{"type":"warmup","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","low":55,"high":65}}]}"#
			)
		)
		let json = try await runtime().rebuildConfirmed(.createWorkout(date: "1998-06-14", workout: workout))
		#expect(json.objectFields["created"]?.boolValue == true)
		#expect(intervals.calls.last == .createEvent(date: "1998-06-14", externalId: "cycling-coach:1998-06-14:endurance"))
	}

	@Test func pastDateIsRefusedAtTheBoundary() async throws {
		let outcome = try await runtime().execute(
			name: .intervalsCreateWorkout,
			arguments: try JSONValue.parse(
				#"{"date":"1998-06-12","workout":{"name":"Endurance","steps":[{"type":"steady","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","value":60}}]}}"#
			),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let json) = outcome else {
			Issue.record("expected error result")
			return
		}
		#expect(unwrapData(json).objectFields["error"]?.stringValue == "past_date_refused")
	}

	private var enduranceArguments: String {
		#"{"date":"1998-06-14","workout":{"name":"Endurance","steps":[{"type":"warmup","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","low":55,"high":65}}]}}"#
	}

	private func unwrapData(_ json: JSONValue) -> JSONValue {
		json.objectFields["data"] ?? json
	}

	private func runtime() -> ToolRuntime {
		let store = InMemoryRecordLog()
		return ToolRuntime(
			intervals: intervals,
			store: store,
			planning: Planning(store: store, intervals: intervals, clock: clock),
			clock: clock
		)
	}

	private func turnState() -> TurnState {
		TurnState(
			chatId: .main,
			messages: [],
			windowStart: nil,
			pending: nil,
			writesCommitted: 0,
			flushedThisTurn: false,
			lastFlushMessageCount: 0,
			steps: 0
		)
	}
}

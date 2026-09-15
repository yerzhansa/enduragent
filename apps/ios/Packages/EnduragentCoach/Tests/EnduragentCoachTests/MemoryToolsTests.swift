import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct MemoryToolsTests {
	let intervals = FakeIntervalsClient(athleteName: "Ada Kovač", ftp: 250)
	let clock = FixedClock(now: "1998-06-13T12:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func memoryReadOmittedWhenNotesAreStampOnly() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.writeSection(.notes, content: "", source: .chat)
		let view = try await memory.view()
		let schemas = runtime(store: store).toolsForTurn(chatId: .main, memory: view)
		#expect(!schemas.map(\.name).contains(.memoryRead))
		try await memory.writeSection(.notes, content: "- Prefers hill repeats", source: .chat)
		let withNotes = try await memory.view()
		let offered = runtime(store: store).toolsForTurn(chatId: .main, memory: withNotes)
		#expect(offered.map(\.name).contains(.memoryRead))
	}

	@Test func ledgerAppendReturnsDuplicateFlag() async throws {
		let store = InMemoryRecordLog()
		let tools = runtime(store: store)
		let first = try await tools.execute(
			name: .ledgerAppend,
			arguments: try JSONValue.parse(
				#"{"date":"1998-06-13","kind":"decision","text":"Rides with a group on Saturdays"}"#
			),
			chatId: .main,
			state: turnState()
		)
		let second = try await tools.execute(
			name: .ledgerAppend,
			arguments: try JSONValue.parse(
				#"{"date":"1998-06-13","kind":"decision","text":"Rides with a group on Saturdays"}"#
			),
			chatId: .main,
			state: turnState()
		)
		#expect(unwrap(first).objectFields["recorded"]?.boolValue == true)
		#expect(unwrap(second).objectFields["recorded"]?.boolValue == false)
		#expect(unwrap(second).objectFields["duplicate"]?.boolValue == true)
	}

	@Test func memoryQueryInvalidRangeReturnsCopiedError() async throws {
		let outcome = try await runtime().execute(
			name: .memoryQuery,
			arguments: try JSONValue.parse(#"{"from":"1998-06-30","to":"1998-06-01"}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(
			unwrapString(outcome)
				== "Error: 'from' (1998-06-30) is after 'to' (1998-06-01). Swap the bounds."
		)
	}

	@Test func memoryQueryInvalidDateReturnsCopiedError() async throws {
		let outcome = try await runtime().execute(
			name: .memoryQuery,
			arguments: try JSONValue.parse(#"{"from":"1998-02-31","to":"1998-03-01"}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(
			unwrapString(outcome)
				== "Error: 1998-02-31..1998-03-01 contains an invalid calendar date. Use real YYYY-MM-DD dates."
		)
	}

	@Test func memoryWriteAcceptsOrphanName() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.writeSection(SectionName(rawValue: "random-legacy"), content: "stale orphan body", source: .chat)
		let tools = runtime(store: store)
		let view = try await memory.view()
		let schema = tools.toolsForTurn(chatId: .main, memory: view).first { $0.name == .memoryWrite }
		let encoded = canonicalJSON(schema?.parameters ?? .null)
		#expect(encoded.contains("random-legacy"))
		let result = try await tools.execute(
			name: .memoryWrite,
			arguments: try JSONValue.parse(
				#"{"type":"memory","section":"random-legacy","content":"updated orphan"}"#
			),
			chatId: .main,
			state: turnState()
		)
		#expect(unwrap(result).objectFields["saved"]?.boolValue == true)
	}

	@Test func memoryWriteDailyAppendsToday() async throws {
		let store = InMemoryRecordLog()
		let result = try await runtime(store: store).execute(
			name: .memoryWrite,
			arguments: try JSONValue.parse(#"{"type":"daily","content":"Group ride on Saturdays"}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(unwrap(result).objectFields["saved"]?.boolValue == true)
		let notes = try await store.fetch(RecordQuery(kinds: [.dailyNote]))
		#expect(notes.count == 1)
	}

	private func unwrap(_ outcome: ToolOutcome) -> JSONValue {
		guard case .result(let json) = outcome else { return .null }
		return json.objectFields["data"] ?? json
	}

	private func unwrapString(_ outcome: ToolOutcome) -> String {
		unwrap(outcome).stringValue ?? ""
	}

	private func runtime(store: InMemoryRecordLog = InMemoryRecordLog()) -> ToolRuntime {
		ToolRuntime(
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

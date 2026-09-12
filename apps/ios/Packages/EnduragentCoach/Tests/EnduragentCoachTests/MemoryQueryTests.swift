import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct MemoryQueryTests {
	let clock = FixedClock(now: "1998-06-13T12:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func newestDateFirst() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		_ = try await memory.appendEvent(date: "1998-06-13", kind: .decision, text: "Hold volume this week", source: .flush)
		_ = try await memory.appendEvent(date: "1998-06-01", kind: .illness, text: "Easy week after a cold", source: .chat)
		_ = try await memory.appendEvent(date: "1998-06-30", kind: .outcome, text: "Group ride felt strong", source: .chat)
		let hits = try await memory.query(from: "1998-06-01", to: "1998-06-30", contains: nil)
		#expect(hits.map(\.date) == ["1998-06-30", "1998-06-13", "1998-06-01"])
	}

	@Test func renderEmptyRangeCopiesDesktopString() {
		let rendered = MemoryQuery.render([], from: "1998-06-01", to: "1998-06-30")
		#expect(rendered == "Memory query 1998-06-01..1998-06-30: no daily notes, events, or history found.")
	}

	@Test func renderRejectsInvertedRangeThroughQuery() async throws {
		let memory = Memory(store: InMemoryRecordLog(), clock: clock)
		do {
			_ = try await memory.query(from: "1998-06-30", to: "1998-06-01", contains: nil)
			Issue.record("expected failure")
		} catch let failure as MemoryQueryFailure {
			#expect(failure.message == "Error: 'from' (1998-06-30) is after 'to' (1998-06-01). Swap the bounds.")
		}
	}

	@Test func renderTruncationCopiesDesktopString() {
		let filler = String(repeating: "a", count: MemoryQuery.maxResultChars + 40)
		let hits = [MemoryHit(date: "1998-06-13", kind: .dailyNote, text: filler)]
		let rendered = MemoryQuery.render(hits, from: "1998-06-01", to: "1998-06-30")
		#expect(rendered.hasSuffix("\n[truncated — narrow the date range or add a query term]"))
		#expect(rendered.utf16.count > MemoryQuery.maxResultChars)
	}

	@Test func queryRendersDailyThenEventThenHistory() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.appendDailyNote("Felt fresh on the morning spin.")
		_ = try await memory.appendEvent(
			date: "1998-06-13",
			kind: .decision,
			text: "Hold volume this week",
			source: .flush
		)
		try await memory.writeSection(.person, content: "- Name: Ada Kovač", source: .chat)
		let hits = try await memory.query(from: "1998-06-13", to: "1998-06-13", contains: nil)
		#expect(hits.map(\.kind) == [.dailyNote, .ledger(.decision), .journal])
		let rendered = MemoryQuery.render(hits, from: "1998-06-13", to: "1998-06-13")
		#expect(rendered.contains("## 1998-06-13\nFelt fresh on the morning spin.\nevent: "))
		#expect(rendered.contains("history: "))
	}

	@Test func overMaxRangeThrowsCopiedError() async throws {
		let memory = Memory(store: InMemoryRecordLog(), clock: clock)
		do {
			_ = try await memory.query(from: "1998-01-01", to: "1999-01-03", contains: nil)
			Issue.record("expected failure")
		} catch let failure as MemoryQueryFailure {
			#expect(
				failure.message
					== "Error: range is 368 days; the maximum is 366. Query a narrower range."
			)
		}
	}
}

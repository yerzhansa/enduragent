import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct MemoryDifferentialTests {
	let clock = FixedClock(now: "1998-06-13T12:00:00+00:00", timeZone: "Europe/Amsterdam")

	@Test func copiedQueryStringsMatchDesktop() {
		#expect(
			MemoryQuery.render([], from: "1998-06-01", to: "1998-06-30")
				== "Memory query 1998-06-01..1998-06-30: no daily notes, events, or history found."
		)
		#expect(MemoryQuery.truncationNotice == "[truncated — narrow the date range or add a query term]")
		#expect(MemoryQuery.emptySuffix == ": no daily notes, events, or history found.")
	}

	@Test func dumpsContextAndQueryAgainstDesktop() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await seedAda(memory)
		let context = try await memory.context()
		let hits = try await memory.query(from: "1998-06-01", to: "1998-06-30", contains: nil)
		let query = MemoryQuery.render(hits, from: "1998-06-01", to: "1998-06-30")
		let skip = injectableDailyLines(MemoryDifferentialFixture.dailyWithSkip).joined(separator: "\n")
		try writeDump("context-swift.txt", context)
		try writeDump("query-swift.txt", query)
		try writeDump("empty-swift.txt", MemoryQuery.render([], from: "1998-01-01", to: "1998-01-02"))
		try writeDump("truncation-suffix-swift.txt", MemoryQuery.truncationNotice)
		try writeDump("injectable-swift.txt", skip)
		try compareIfPresent("empty-ts.txt", MemoryQuery.render([], from: "1998-01-01", to: "1998-01-02"))
		try compareIfPresent("truncation-suffix-ts.txt", MemoryQuery.truncationNotice)
		try compareIfPresent("injectable-ts.txt", skip)
		try compareIfPresent("context-ts.txt", context)
		try compareIfPresent("query-ts.txt", query)
	}

	private func seedAda(_ memory: Memory) async throws {
		try await memory.writeSection(.person, content: "- Name: Ada Kovač", source: .chat)
		try await memory.writeSection(.schedule, content: "- Saturdays group ride", source: .chat)
		try await memory.writeSection(.cyclingProfile, content: "- FTP 250W", source: .chat)
		try await memory.writeSection(
			SectionName(rawValue: "random-legacy"),
			content: "stale orphan body",
			source: .chat
		)
		try await memory.appendDailyNote("Felt fresh on the morning spin.")
		try await memory.appendDailyNote(MemoryDifferentialFixture.compactionNote)
		try await memory.appendDailyNote("Knee felt fine on the evening spin.")
		_ = try await memory.appendEvent(
			date: "1998-06-01",
			kind: .illness,
			text: "Easy week after a cold",
			source: .flush
		)
		_ = try await memory.appendEvent(
			date: "1998-06-13",
			kind: .decision,
			text: "Hold volume this week",
			source: .flush
		)
		_ = try await memory.appendEvent(
			date: "1998-06-13",
			kind: .decision,
			text: "Hold volume this week",
			source: .flush
		)
		_ = try await memory.appendEvent(
			date: "1998-06-30",
			kind: .outcome,
			text: "Group ride felt strong",
			source: .flush
		)
	}

	private func writeDump(_ name: String, _ text: String) throws {
		let dir = URL(fileURLWithPath: "/tmp/ios-c5", isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		try Data(text.utf8).write(to: dir.appendingPathComponent(name), options: .atomic)
	}

	private func compareIfPresent(_ name: String, _ actual: String) throws {
		let url = URL(fileURLWithPath: "/tmp/ios-c5").appendingPathComponent(name)
		guard FileManager.default.fileExists(atPath: url.path) else { return }
		let expected = String(decoding: try Data(contentsOf: url), as: UTF8.self)
		#expect(actual == expected, "mismatch vs \(name)")
	}
}

enum MemoryDifferentialFixture {
	static let compactionNote = """
		### Compaction summary

		#### Athlete Profile
		- FTP 240W
		### End of compaction summary
		"""

	static let dailyWithSkip = """
		Felt fresh on the morning spin.
		### Compaction summary

		#### Athlete Profile
		- FTP 240W
		### End of compaction summary
		Knee felt fine on the evening spin.
		### Compaction summary
		hidden inside skip
		## person
		kept after H2 exit
		"""
}

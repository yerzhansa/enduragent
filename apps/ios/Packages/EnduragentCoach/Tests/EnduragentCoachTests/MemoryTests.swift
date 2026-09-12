import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct MemoryTests {
	let clock = FixedClock(now: "1998-06-13T12:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func journalRecordPrecedesSectionRecord() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.writeSection(.person, content: "## Ada Kovač\nRides on Saturdays.", source: .chat)
		let records = try await store.fetch(RecordQuery(kinds: [.journal, .memorySection]))
			.sorted { $0.hlc < $1.hlc }
		#expect(records.count == 2)
		guard case .journal(let journal) = records[0].body else {
			Issue.record("expected journal first")
			return
		}
		guard case .memorySection(let section) = records[1].body else {
			Issue.record("expected section second")
			return
		}
		#expect(journal.op == .writeSection)
		#expect(records[0].hlc < records[1].hlc)
		#expect(section.name == .person)
		#expect(section.content.hasPrefix("_updated: 1998-06-13"))
		#expect(!section.content.contains("\n## "))
		#expect(section.content.contains("### Ada Kovač"))
		#expect(section.content.contains("_updated: 1998-06-13\n"))
		let stamps = section.content.split(separator: "\n").filter { $0.hasPrefix("_updated: ") }
		#expect(stamps.count == 1)
	}

	@Test func appendDailyNoteSkipsWholeLineDuplicateWithoutJournal() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.appendDailyNote("Felt fresh on the morning spin.")
		try await memory.appendDailyNote("Felt fresh on the morning spin.")
		try await memory.appendDailyNote("Knee felt fine on the evening spin.")
		let notes = try await store.fetch(RecordQuery(kinds: [.dailyNote, .journal]))
		#expect(notes.filter { if case .dailyNote = $0.body { true } else { false } }.count == 2)
		#expect(notes.filter { if case .journal = $0.body { true } else { false } }.isEmpty)
	}

	@Test func appendEventReturnsFalseOnTwoDeviceDuplicate() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		let other = DeviceID(rawValue: "phone-b")
		let now = clock.now
		try await store.append(
			AthleteRecord(
				ulid: ULID.generate(at: now),
				deviceId: other,
				hlc: .tick(now: now, deviceId: other, last: nil),
				timeZone: IANATimeZone(identifier: "Europe/Amsterdam")!,
				civilDate: "1998-06-13",
				body: .ledgerEvent(LedgerEventBody(kind: .decision, text: "Keep Saturdays free.", source: .chat))
			)
		)
		let recorded = try await memory.appendEvent(
			date: "1998-06-13",
			kind: .decision,
			text: "  Keep Saturdays   free.  ",
			source: .flush
		)
		#expect(recorded == false)
		let events = try await store.fetch(RecordQuery(kinds: [.ledgerEvent]))
		#expect(events.count == 1)
	}

	@Test func contextInjectsOrphansAndStripsCompaction() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.writeSection(.person, content: "- Name: Ada Kovač", source: .chat)
		try await memory.writeSection(.notes, content: "- Prefers hill repeats", source: .chat)
		try await memory.writeSection(
			SectionName(rawValue: "random-legacy"),
			content: "stale orphan body",
			source: .chat
		)
		try await memory.appendDailyNote("Felt fresh on the morning spin.")
		try await memory.appendDailyNote(
			"""
			### Compaction summary

			#### Athlete Profile
			- FTP 240W
			### End of compaction summary
			"""
		)
		try await memory.appendDailyNote("Knee felt fine on the evening spin.")
		let context = try await memory.context()
		#expect(context.contains("## Athlete Memory"))
		#expect(context.contains("## person"))
		#expect(context.contains("Ada Kovač"))
		#expect(context.contains("## random-legacy"))
		#expect(context.contains("stale orphan body"))
		#expect(!context.contains("## notes"))
		#expect(context.contains("## Today's Notes"))
		#expect(context.contains("Felt fresh on the morning spin."))
		#expect(context.contains("Knee felt fine on the evening spin."))
		#expect(!context.contains("### Compaction summary"))
		#expect(!context.contains("FTP 240W"))
		#expect(!context.contains("## Current Plan"))
		let view = try await memory.view()
		#expect(view.orphanNames == ["random-legacy"])
		#expect(view.planHeadline == nil)
	}

	@Test func injectableDailyLinesDropsMarkersAndExitsOnH3() {
		let daily = [
			"Felt fresh on the morning spin.",
			"### Compaction summary",
			"",
			"#### Athlete Profile",
			"- FTP 240W",
			"### End of compaction summary",
			"Knee felt fine on the evening spin.",
			"### Compaction summary",
			"hidden inside skip",
			"## person",
			"kept after H2 exit",
		].joined(separator: "\n")
		#expect(
			injectableDailyLines(daily).joined(separator: "\n")
				== [
					"Felt fresh on the morning spin.",
					"Knee felt fine on the evening spin.",
					"## person",
					"kept after H2 exit",
				].joined(separator: "\n")
		)
	}

	@Test func writeSectionReplacesLeadingStampRatherThanStacking() async throws {
		let store = InMemoryRecordLog()
		let memory = Memory(store: store, clock: clock)
		try await memory.writeSection(.person, content: "_updated: 1998-06-01\n- Name: Ada", source: .chat)
		let records = try await store.fetch(RecordQuery(kinds: [.memorySection]))
		guard case .memorySection(let body) = records.last?.body else {
			Issue.record("expected section")
			return
		}
		#expect(body.content == "_updated: 1998-06-13\n- Name: Ada")
	}
}

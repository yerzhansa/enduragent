import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct UnionMergeTests {
	let amsterdam = IANATimeZone(identifier: "Europe/Amsterdam")!
	let phoneA = DeviceID(rawValue: "phone-a")
	let phoneB = DeviceID(rawValue: "phone-b")

	@Test func twoDeviceInterleave() {
		let first = record(
			device: phoneB,
			wall: 100,
			ulid: ulid(0),
			body: .userMessage(sampleUser(chatId: .main, text: "from b"))
		)
		let second = record(
			device: phoneA,
			wall: 100,
			logical: 1,
			ulid: ulid(1),
			body: .assistantMessage(sampleAssistant(chatId: .main, text: "from a"))
		)
		let third = record(
			device: phoneB,
			wall: 101,
			ulid: ulid(2),
			body: .userMessage(sampleUser(chatId: .main, text: "from b later"))
		)
		let messages = UnionMerge.conversation([third, first, second], chatId: .main, deviceId: phoneA)
		#expect(messages.map(\.text) == ["from b", "from a", "from b later"])
		#expect(messages.map(\.role) == [.user, .assistant, .user])
	}

	@Test func windowStartCut() {
		let one = record(
			device: phoneA,
			wall: 1,
			ulid: ulid(1),
			body: .userMessage(sampleUser(chatId: .main, text: "old"))
		)
		let two = record(
			device: phoneB,
			wall: 2,
			ulid: ulid(2),
			body: .assistantMessage(sampleAssistant(chatId: .main, text: "also old"))
		)
		let kept = record(
			device: phoneA,
			wall: 3,
			ulid: ulid(3),
			body: .userMessage(sampleUser(chatId: .main, text: "kept"))
		)
		let reply = record(
			device: phoneB,
			wall: 4,
			ulid: ulid(4),
			body: .assistantMessage(sampleAssistant(chatId: .main, text: "kept reply"))
		)
		let window = record(
			device: phoneA,
			wall: 5,
			ulid: ulid(5),
			body: .windowStart(WindowStartBody(chatId: .main, firstIncludedUlid: kept.ulid))
		)
		let otherWindow = record(
			device: phoneB,
			wall: 6,
			ulid: ulid(6),
			body: .windowStart(WindowStartBody(chatId: .main, firstIncludedUlid: one.ulid))
		)
		let messages = UnionMerge.conversation(
			[one, two, kept, reply, window, otherWindow],
			chatId: .main,
			deviceId: phoneA
		)
		#expect(messages.map(\.text) == ["kept", "kept reply"])
	}

	@Test func sectionHighestHLC() {
		let earlier = record(
			device: phoneA,
			wall: 1,
			ulid: ulid(1),
			body: .memorySection(MemorySectionBody(name: .person, content: "Ada, older"))
		)
		let later = record(
			device: phoneB,
			wall: 2,
			ulid: ulid(2),
			body: .memorySection(MemorySectionBody(name: .person, content: "Ada Kovač"))
		)
		let other = record(
			device: phoneA,
			wall: 3,
			ulid: ulid(3),
			body: .memorySection(MemorySectionBody(name: .schedule, content: "Saturdays free"))
		)
		#expect(UnionMerge.sectionText([earlier, later, other], name: .person) == "Ada Kovač")
		#expect(UnionMerge.sectionText([earlier, later, other], name: .schedule) == "Saturdays free")
		#expect(UnionMerge.sectionText([earlier, later, other], name: .goals) == nil)
	}

	@Test func ledgerDedupeAcrossDevices() {
		let first = record(
			device: phoneA,
			wall: 1,
			date: "1998-06-13",
			ulid: ulid(1),
			body: .ledgerEvent(LedgerEventBody(kind: .decision, text: "Keep Saturdays free.", source: .chat))
		)
		let duplicate = record(
			device: phoneB,
			wall: 2,
			date: "1998-06-13",
			ulid: ulid(2),
			body: .ledgerEvent(
				LedgerEventBody(kind: .decision, text: "  Keep Saturdays   free.  ", source: .flush)
			)
		)
		let extra = record(
			device: phoneA,
			wall: 3,
			date: "1998-06-14",
			ulid: ulid(3),
			body: .ledgerEvent(LedgerEventBody(kind: .illness, text: "Knee niggle.", source: .chat))
		)
		let events = UnionMerge.ledger([duplicate, extra, first])
		#expect(events.map(\.text) == ["Keep Saturdays free.", "Knee niggle."])
		#expect(events.map(\.kind) == [.decision, .illness])
	}

	@Test func proposalClearedThenAbsent() {
		let nonce = Nonce()
		let now = Date(timeIntervalSince1970: 899_164_800)
		let live = record(
			device: phoneA,
			wall: 1,
			ulid: ulid(1),
			body: .pendingProposal(sampleProposal(chatId: .main, nonce: nonce, expiresAt: now.addingTimeInterval(600)))
		)
		#expect(UnionMerge.pendingProposal([live], chatId: .main, now: now)?.nonce == nonce)
		let cleared = record(
			device: phoneA,
			wall: 2,
			ulid: ulid(2),
			body: .proposalCleared(
				ProposalClearedBody(chatId: .main, nonce: nonce, reason: .executed)
			)
		)
		#expect(UnionMerge.pendingProposal([live, cleared], chatId: .main, now: now) == nil)
		let expired = record(
			device: phoneA,
			wall: 3,
			ulid: ulid(3),
			body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: now))
		)
		#expect(UnionMerge.pendingProposal([expired], chatId: .main, now: now) == nil)
	}

	@Test func planningDeviceAndReplyLanguageHighestHLC() {
		let firstDevice = record(
			device: phoneA,
			wall: 1,
			ulid: ulid(1),
			body: .planningDevice(
				PlanningDeviceBody(planningDeviceId: phoneA, planUlid: ulid(10), activatedAt: Date(timeIntervalSince1970: 10))
			)
		)
		let secondDevice = record(
			device: phoneB,
			wall: 2,
			ulid: ulid(2),
			body: .planningDevice(
				PlanningDeviceBody(planningDeviceId: phoneB, planUlid: ulid(11), activatedAt: Date(timeIntervalSince1970: 20))
			)
		)
		#expect(UnionMerge.planningDevice([firstDevice, secondDevice])?.planningDeviceId == phoneB)
		let italian = record(
			device: phoneA,
			wall: 3,
			ulid: ulid(3),
			body: .coachReplyLanguage(CoachReplyLanguageBody(tag: .it))
		)
		let automatic = record(
			device: phoneB,
			wall: 4,
			ulid: ulid(4),
			body: .coachReplyLanguage(CoachReplyLanguageBody(tag: nil))
		)
		#expect(UnionMerge.coachReplyLanguage([italian]) == .it)
		#expect(UnionMerge.coachReplyLanguage([italian, automatic]) == nil)
	}

	@Test func ledgerDigestUsesKindRawValue() {
		let date: CivilDate = "1998-06-13"
		let text = "Keep Saturdays free."
		let fromKind = UnionMerge.ledgerDigest(date: date, kind: .decision, text: text)
		let fromString = UnionMerge.ledgerDigest(date: date.rawValue, kind: LedgerKind.decision.rawValue, text: text)
		#expect(fromKind == fromString)
		#expect(fromKind.count == 64)
	}

	@Test func ledgerDigestMatchesDesktop() throws {
		let rows = try loadLedgerDigestTable()
		var computed: [LedgerDigestRow] = []
		for row in rows {
			let normalized = row.text.replacing(/^[\s]+|[\s]+$/, with: "").replacing(/\s+/, with: " ").lowercased()
			let digestInput = JSONValue.array([
				.string(row.date),
				.string(row.kind),
				.string(normalized),
			]).canonicalDigestInput()
			let digest = UnionMerge.ledgerDigest(date: row.date, kind: row.kind, text: row.text)
			#expect(digestInput == row.digestInput)
			#expect(digest == row.digest)
			#expect(Array(digestInput.utf8) == Array(row.digestInput.utf8))
			#expect(Array(digest.utf8) == Array(row.digest.utf8))
			if let kind = LedgerKind(rawValue: row.kind), let date = CivilDate(rawValue: row.date) {
				#expect(UnionMerge.ledgerDigest(date: date, kind: kind, text: row.text) == row.digest)
			}
			computed.append(
				LedgerDigestRow(
					date: row.date,
					kind: row.kind,
					text: row.text,
					digestInput: digestInput,
					digest: digest,
					estimateTokens: estimateTokens(row.text)
				)
			)
		}
		if let path = ProcessInfo.processInfo.environment["ENDURAGENT_DIGEST_OUT"], !path.isEmpty {
			try encodeDigestTable(computed).write(toFile: path, atomically: true, encoding: .utf8)
		}
	}

	private func record(
		device: DeviceID,
		wall: Int64,
		logical: UInt32 = 0,
		date: CivilDate = "1998-06-13",
		ulid: ULID,
		body: RecordBody
	) -> AthleteRecord {
		AthleteRecord(
			ulid: ulid,
			deviceId: device,
			hlc: HybridLogicalClock(wallMs: wall, logical: logical, deviceId: device),
			timeZone: amsterdam,
			civilDate: date,
			body: body
		)
	}

	private func ulid(_ offset: Int) -> ULID {
		ULID.generate(at: Date(timeIntervalSince1970: 899_164_800 + Double(offset)))
	}
}

private func encodeDigestTable(_ rows: [LedgerDigestRow]) -> String {
	let objects = rows.map { row in
		let fields = [
			("date", JSONValue.string(row.date).canonicalDigestInput()),
			("kind", JSONValue.string(row.kind).canonicalDigestInput()),
			("text", JSONValue.string(row.text).canonicalDigestInput()),
			("digestInput", JSONValue.string(row.digestInput).canonicalDigestInput()),
			("digest", JSONValue.string(row.digest).canonicalDigestInput()),
			("estimateTokens", String(row.estimateTokens)),
		]
		let inner = fields.map { "    \"\($0.0)\": \($0.1)" }.joined(separator: ",\n")
		return "  {\n\(inner)\n  }"
	}
	return "[\n" + objects.joined(separator: ",\n") + "\n]\n"
}

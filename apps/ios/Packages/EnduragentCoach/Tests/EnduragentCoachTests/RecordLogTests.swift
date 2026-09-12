import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct RecordLogTests {
	let amsterdam = IANATimeZone(identifier: "Europe/Amsterdam")!
	let phoneA = DeviceID(rawValue: "phone-a")
	let phoneB = DeviceID(rawValue: "phone-b")

	@Test func deviceLocalAppendFromAnotherDeviceThrows() async throws {
		let log = InMemoryRecordLog(deviceId: phoneA)
		let foreign = record(
			device: phoneB,
			wall: 1,
			body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: Date()))
		)
		await #expect(throws: ForeignDeviceLocalRecord.self) {
			try await log.append(foreign)
		}
		try await log.append(
			record(
				device: phoneA,
				wall: 2,
				body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: Date()))
			)
		)
		try await log.append(
			record(device: phoneB, wall: 3, body: .userMessage(sampleUser(chatId: .main, text: "from b")))
		)
	}

	@Test func fetchHonoursEveryQueryField() async throws {
		let log = InMemoryRecordLog(deviceId: phoneA)
		let otherChat = ChatID(rawValue: "other")!
		try await log.append(
			record(
				device: phoneA,
				wall: 10,
				date: "1998-06-13",
				body: .userMessage(sampleUser(chatId: .main, text: "main 13"))
			)
		)
		try await log.append(
			record(
				device: phoneB,
				wall: 11,
				date: "1998-06-14",
				body: .assistantMessage(sampleAssistant(chatId: .main, text: "reply 14"))
			)
		)
		try await log.append(
			record(
				device: phoneA,
				wall: 12,
				date: "1998-06-15",
				body: .userMessage(sampleUser(chatId: otherChat, text: "other 15"))
			)
		)
		try await log.append(
			record(
				device: phoneA,
				wall: 13,
				date: "1998-06-14",
				body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: Date()))
			)
		)

		let kinds = try await log.fetch(RecordQuery(kinds: [.userMessage, .assistantMessage]))
		#expect(kinds.map { text(of: $0) } == ["main 13", "reply 14", "other 15"])

		let mainOnly = try await log.fetch(RecordQuery(kinds: [.userMessage, .assistantMessage], chatId: .main))
		#expect(mainOnly.map { text(of: $0) } == ["main 13", "reply 14"])

		let mid = try await log.fetch(
			RecordQuery(
				kinds: [.userMessage, .assistantMessage],
				from: "1998-06-14",
				to: "1998-06-14"
			)
		)
		#expect(mid.map { text(of: $0) } == ["reply 14"])

		let inclusive = try await log.fetch(
			RecordQuery(
				kinds: [.userMessage, .assistantMessage],
				from: "1998-06-13",
				to: "1998-06-14"
			)
		)
		#expect(inclusive.map { text(of: $0) } == ["main 13", "reply 14"])

		let thisDevice = try await log.fetch(
			RecordQuery(kinds: [.userMessage, .assistantMessage, .pendingProposal], deviceLocalOnly: true)
		)
		#expect(thisDevice.map(\.deviceId) == [phoneA, phoneA, phoneA])
		#expect(Set(thisDevice.map(\.body.kind)) == [.userMessage, .pendingProposal])
	}

	@Test func hlcMonotonicUnderFrozenWallClock() {
		let frozen = Date(timeIntervalSince1970: 899_164_800)
		var last: HybridLogicalClock?
		var ticks: [HybridLogicalClock] = []
		for _ in 0..<5 {
			let next = HybridLogicalClock.tick(now: frozen, deviceId: phoneA, last: last)
			ticks.append(next)
			last = next
		}
		#expect(ticks[0].logical == 0)
		#expect(ticks.map(\.wallMs).allSatisfy { $0 == ticks[0].wallMs })
		#expect(ticks.map(\.logical) == [0, 1, 2, 3, 4])
		for index in 1..<ticks.count {
			#expect(ticks[index - 1] < ticks[index])
		}
		let later = HybridLogicalClock.tick(
			now: frozen.addingTimeInterval(1),
			deviceId: phoneA,
			last: ticks.last
		)
		#expect(later.wallMs > ticks.last!.wallMs)
		#expect(later.logical == 0)
		#expect(ticks.last! < later)
	}

	private func record(
		device: DeviceID,
		wall: Int64,
		logical: UInt32 = 0,
		date: CivilDate = "1998-06-13",
		body: RecordBody
	) -> AthleteRecord {
		AthleteRecord(
			ulid: ULID.generate(at: Date(timeIntervalSince1970: TimeInterval(wall))),
			deviceId: device,
			hlc: HybridLogicalClock(wallMs: wall, logical: logical, deviceId: device),
			timeZone: amsterdam,
			civilDate: date,
			body: body
		)
	}

	private func text(of record: AthleteRecord) -> String {
		switch record.body {
		case .userMessage(let body): return body.athleteText
		case .assistantMessage(let body): return body.text
		default: return ""
		}
	}
}

func sampleUser(chatId: ChatID, text: String) -> UserMessageBody {
	UserMessageBody(chatId: chatId, athleteText: text, timedText: text, slash: nil)
}

func sampleAssistant(chatId: ChatID, text: String) -> AssistantMessageBody {
	AssistantMessageBody(chatId: chatId, text: text, templateHash: "t", assembledHash: "a")
}

func sampleProposal(chatId: ChatID, nonce: Nonce, expiresAt: Date) -> ProposalBody {
	ProposalBody(
		chatId: chatId,
		nonce: nonce,
		tool: .intervalsCreateStrengthWorkout,
		toolInput: .createStrengthWorkout(date: "1998-06-13", name: "Core", description: "20 min"),
		summary: "Core session",
		description: "Core · 20 min",
		expiresAt: expiresAt
	)
}

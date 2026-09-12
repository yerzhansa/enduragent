import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct ChatMailboxTests {
	@Test func concurrentSendsOnOneChatCompleteInOrder() async throws {
		let transport = FakeModelTransport()
		transport.requestDelay = .milliseconds(40)
		transport.script = [
			.text("first"),
			.finish(reason: .stop),
			.text("second"),
			.finish(reason: .stop),
		]
		let coach = Coach(
			sport: .cycling,
			transport: transport,
			intervals: FakeIntervalsClient(athleteName: "Ada", ftp: 250),
			store: InMemoryRecordLog(),
			clock: FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam"),
			language: .init(ui: .en, coachReply: nil)
		)

		async let first = collectText(coach.send("one", chatId: "main"))
		try await Task.sleep(for: .milliseconds(5))
		async let second = collectText(coach.send("two", chatId: "main"))
		let texts = try await [first, second]
		#expect(texts == ["first", "second"])
		let history = await coach.history(chatId: "main")
		#expect(history.map(\.text) == ["one", "first", "two", "second"])
	}

	@Test func confirmDoesNotEnterTheMailbox() async throws {
		let transport = FakeModelTransport()
		transport.hangUntilCancelled = true
		let coach = Coach(
			sport: .cycling,
			transport: transport,
			intervals: FakeIntervalsClient(athleteName: "Ada", ftp: 250),
			store: InMemoryRecordLog(),
			clock: FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam"),
			language: .init(ui: .en, coachReply: nil)
		)
		let stream = coach.send("hang", chatId: "main")
		for _ in 0..<80 {
			if await coach.snapshot(chatId: "main").phase == .streaming {
				break
			}
			try await Task.sleep(for: .milliseconds(10))
		}
		let outcome = try await coach.confirm(chatId: "main", nonce: Nonce())
		#expect(outcome == .none)
		await coach.stop(chatId: "main")
		for try await _ in stream {}
	}
}

private func collectText(_ stream: AsyncThrowingStream<CoachEvent, Error>) async throws -> String {
	var text = ""
	for try await event in stream {
		if case .textDelta(let delta) = event {
			text += delta
		}
	}
	return text
}

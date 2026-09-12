import Testing
@testable import EnduragentCoach

@Suite struct FirstTurnTests {
	let transport = FakeModelTransport()
	let intervals = FakeIntervalsClient(athleteName: "Ada", ftp: 250)
	let store = InMemoryRecordLog()
	let clock = FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")

	func makeCoach() -> Coach {
		Coach(
			sport: .cycling,
			transport: transport,
			intervals: intervals,
			store: store,
			clock: clock,
			language: .init(ui: .en, coachReply: nil)
		)
	}

	@Test func coachStartsWithNoHistory() async throws {
		let coach = makeCoach()
		#expect(await coach.history(chatId: "main").isEmpty)
	}
}

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

	@Test(.disabled("Coach.history is not implemented"))
	func coachStartsWithNoHistory() async throws {
		let coach = makeCoach()
		#expect(await coach.history(chatId: "main").isEmpty)
	}

	@Test(.disabled("TurnRunner.run is not implemented"))
	func toolCallRunsAndFeedsBackIntoTheTurn() async throws {
		intervals.activities = [.ride(name: "Sunday long ride", date: "1998-06-07", durationS: 7200, trainingLoad: 120)]
		transport.script = [
			.toolCall(name: "intervals_fetch_activities", arguments: #"{"days":7}"#),
			.finish(reason: .toolCalls),
			.text("Sunday long ride, 2 h, load 120."),
			.finish(reason: .stop)
		]
		let coach = makeCoach()

		var toolNames: [String] = []
		for try await event in coach.send("Review my last ride", chatId: "main") {
			if case .toolStarted(let name, _) = event { toolNames.append(name) }
		}

		#expect(toolNames == ["intervals_fetch_activities"])
		#expect(transport.requests.count == 2)
		#expect(intervals.calls == [.activities(days: 7)])
	}
}

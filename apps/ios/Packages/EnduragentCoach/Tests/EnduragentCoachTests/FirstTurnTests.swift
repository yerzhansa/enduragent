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

	@Test func replyStreamsTextThenFinishes() async throws {
		transport.script = [.text("Your week: "), .text("two rides, 3 h 10 min."), .finish(reason: .stop)]
		let coach = makeCoach()

		var text = ""
		var finished = false
		for try await event in coach.send("What did my week look like?", chatId: "main") {
			switch event {
			case .textDelta(let delta): text += delta
			case .finished: finished = true
			default: break
			}
		}

		#expect(text == "Your week: two rides, 3 h 10 min.")
		#expect(finished)
		#expect(await coach.history(chatId: "main").count == 2)

		let request = transport.requests[0]
		#expect(request.stream == true)
		#expect(request.messages.first?.role == .system)
		#expect(request.messages.first?.content.contains("=== BEGIN ATHLETE DATA") == true)
		#expect(request.messages.last?.content.contains("Current time:") == true)
		#expect(request.messages.last?.content.contains("1998-06-13") == true)
		#expect(request.tools.map(\.name.rawValue).contains("intervals_fetch_activities"))
		#expect(request.messages.first?.content.hasPrefix("# Cycling Coach") == true)
	}

	@Test func toolCallRunsAndFeedsBackIntoTheTurn() async throws {
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
		#expect(
			intervals.calls == [
				.wellness(oldest: "1998-06-07", newest: "1998-06-13"),
				.activities(days: 7),
			]
		)
	}
}

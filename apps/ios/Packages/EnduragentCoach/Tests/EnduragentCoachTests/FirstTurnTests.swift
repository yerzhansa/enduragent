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

	@Test func memoryIsWrittenAfterTheReplyAndQueryable() async throws {
		transport.script = [
			.text("Noted: group ride on Saturdays."), .finish(reason: .stop),
			.toolCall(name: "ledger_append", arguments: #"{"kind":"decision","date":"1998-06-13","text":"Rides with a group on Saturdays"}"#),
			.finish(reason: .toolCalls), .finish(reason: .stop)
		]
		let coach = makeCoach()
		for try await _ in coach.send("Remember that I ride with a group on Saturdays", chatId: "main") {}
		await coach.waitForMemoryFlush()

		let hits = try await coach.memory.query(from: "1998-06-01", to: "1998-06-30", contains: "Saturdays")
		#expect(hits.count == 1)
		#expect(hits[0].date == "1998-06-13")
		#expect(hits[0].kind == .ledger(.decision))
	}

	@Test func calendarWriteBecomesAPendingProposal() async throws {
		transport.script = [
			.toolCall(name: "intervals_create_workout", arguments: workoutArguments),
			.finish(reason: .toolCalls),
			.text("I've prepared the ride. Confirm to add it."),
			.finish(reason: .stop)
		]
		let coach = makeCoach()

		var proposal: PendingProposal?
		for try await event in coach.send("Give me an endurance ride for tomorrow", chatId: "main") {
			if case .proposalPending(let pending) = event { proposal = pending }
		}

		let pending = try #require(proposal)
		#expect(pending.chatId == "main")
		#expect(pending.summary == "Create workout \"Endurance\" on 1998-06-14")
		#expect(pending.description.hasPrefix("Warmup\n- 10m 55-65%"))
		#expect(pending.expiresAt == clock.now.addingTimeInterval(10 * 60))
		#expect(
			!intervals.calls.contains { call in
				if case .createEvent = call { return true }
				return false
			}
		)
		#expect(await coach.pendingProposal(chatId: "main")?.nonce == pending.nonce)
	}

	@Test func confirmRunsTheWriteOnce() async throws {
		let coach = makeCoach()
		let pending = try await proposeEnduranceRide(coach)

		let outcome = try await coach.confirm(chatId: "main", nonce: pending.nonce)

		#expect(outcome == .executed(summary: "Create workout \"Endurance\" on 1998-06-14"))
		#expect(intervals.calls.last == .createEvent(date: "1998-06-14", externalId: "cycling-coach:1998-06-14:endurance"))
		#expect(await coach.pendingProposal(chatId: "main") == nil)

		let again = try await coach.confirm(chatId: "main", nonce: pending.nonce)
		#expect(again == .none)
	}

	var workoutArguments: String {
		#"{"date":"1998-06-14","workout":{"name":"Endurance","steps":[{"type":"warmup","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","low":55,"high":65}},{"type":"steady","duration":{"value":70,"unit":"minutes"},"power":{"kind":"percent_ftp","low":56,"high":75}},{"type":"cooldown","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","value":50}}]}}"#
	}

	func proposeEnduranceRide(_ coach: Coach) async throws -> PendingProposal {
		transport.script = [
			.toolCall(name: "intervals_create_workout", arguments: workoutArguments),
			.finish(reason: .toolCalls),
			.text("I've prepared the ride. Confirm to add it."),
			.finish(reason: .stop)
		]
		var proposal: PendingProposal?
		for try await event in coach.send("Give me an endurance ride for tomorrow", chatId: "main") {
			if case .proposalPending(let pending) = event { proposal = pending }
		}
		return try #require(proposal)
	}
}

import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct TurnRunnerTests {
	let transport = FakeModelTransport()
	let intervals = FakeIntervalsClient(athleteName: "Ada", ftp: 250)
	let store = InMemoryRecordLog()
	let clock = FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func tenthStepRunsToolsThenStops() async throws {
		intervals.activities = [.ride(name: "Sunday long ride", date: "1998-06-07", durationS: 7200, trainingLoad: 120)]
		var script: [ScriptedEvent] = []
		for _ in 0..<10 {
			script.append(.text("."))
			script.append(.toolCall(name: "intervals_fetch_activities", arguments: #"{"days":7}"#))
			script.append(.finish(reason: .toolCalls))
		}
		transport.script = script
		let coach = makeCoach()
		var finished = false
		for try await event in coach.send("Keep fetching", chatId: "main") {
			if case .finished = event { finished = true }
		}
		#expect(finished)
		#expect(transport.requests.count == 10)
	}

	@Test func overflowLengthCompactsAndRetries() async throws {
		transport.finishUsage = Usage(inputTokens: TurnPolicy.contextWindowCap, outputTokens: 8, cost: nil)
		transport.script = [
			.text("truncated"),
			.finish(reason: .length),
			.text("## Athlete Profile\n## Training Status\n## Coach Stance\n## Discussion Context\n## Pending Questions"),
			.finish(reason: .stop),
			.text("after compact"),
			.finish(reason: .stop),
		]
		let coach = makeCoach()
		var text = ""
		for try await event in coach.send("Long history", chatId: "main") {
			if case .textDelta(let delta) = event { text += delta }
		}
		#expect(text.contains("after compact") || text.contains("truncated"))
		#expect(transport.requests.count >= 2)
		let records = try await store.fetch(RecordQuery(kinds: [.compactionSummary, .windowStart], chatId: "main"))
		#expect(!records.isEmpty)
	}

	@Test func backgroundRemainingBelowWatchdogInterruptsWithoutGenerate() async throws {
		clock.backgroundRemaining = .seconds(10)
		transport.script = [.text("should not run"), .finish(reason: .stop)]
		let coach = makeCoach()
		var interrupted: String?
		for try await event in coach.send("Any news?", chatId: "main") {
			if case .interrupted(let text) = event { interrupted = text }
		}
		#expect(interrupted != nil)
		#expect(transport.requests.isEmpty)
		let pending = try await store.fetch(RecordQuery(kinds: [.flushPending], chatId: "main", deviceLocalOnly: true))
		#expect(!pending.isEmpty)
	}

	@Test func planSlashFinishesWithoutACard() async throws {
		transport.script = [.text("no"), .finish(reason: .stop)]
		let coach = makeCoach()
		var events: [CoachEvent] = []
		for try await event in coach.send("/plan", chatId: "main") {
			events.append(event)
		}
		#expect(events == [.finished])
		#expect(transport.requests.isEmpty)
		#expect(await coach.history(chatId: "main").isEmpty)
	}

	private func makeCoach() -> Coach {
		Coach(
			sport: .cycling,
			transport: transport,
			intervals: intervals,
			store: store,
			clock: clock,
			language: .init(ui: .en, coachReply: nil)
		)
	}
}

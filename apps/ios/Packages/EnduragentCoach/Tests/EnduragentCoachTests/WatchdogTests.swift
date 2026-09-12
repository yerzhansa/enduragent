import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct WatchdogTests {
	@Test func pauseForToolsSuppressesFireUntilCleared() async {
		let watchdog = ChatWatchdog()
		await watchdog.arm()
		await watchdog.pauseForTools(["call-1"])
		try? await Task.sleep(for: .milliseconds(80))
		await watchdog.disarm()
		let afterDisarm = await watchdog.fired()
		#expect(afterDisarm == nil)
	}

	@Test func neverEmittingTransportFailsTheTurn() async throws {
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
		var failed: String?
		for try await event in coach.send("Hello", chatId: "main") {
			if case .failed(let message) = event {
				failed = message
			}
		}
		#expect(failed == "CHAT_TTFT_TIMEOUT")
	}
}

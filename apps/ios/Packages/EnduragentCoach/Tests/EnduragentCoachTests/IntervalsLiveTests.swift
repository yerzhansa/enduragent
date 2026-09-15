import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct IntervalsLiveTests {
	static var hasAPIKey: Bool {
		ProcessInfo.processInfo.environment["INTERVALS_API_KEY"].map { !$0.isEmpty } ?? false
	}

	@Test(.enabled(if: hasAPIKey))
	func readsSevenDays() async throws {
		let key = try #require(ProcessInfo.processInfo.environment["INTERVALS_API_KEY"])
		let client = IntervalsRESTClient(credential: .apiKey(key))
		let today = IntervalsPolicy.today(now: Date(), timeZone: TimeZone.current)
		let past = today.adding(days: -(IntervalsPolicy.reviewWindowDays - 1))
		let future = today.adding(days: IntervalsPolicy.reviewWindowDays - 1)

		let athlete = try await client.fetchAthlete()
		let wellness = try await client.fetchWellness(oldest: past, newest: today)
		let activities = try await client.fetchActivities(oldest: past, newest: today)
		let events = try await client.listEvents(oldest: today, newest: future)

		print(athlete.name)
		for day in wellness {
			let fitness = day.fitness.map { String($0) } ?? "none"
			let fatigue = day.fatigue.map { String($0) } ?? "none"
			let form = day.form.map { String($0) } ?? "none"
			print("\(day.date) Fitness \(fitness) Fatigue \(fatigue) Form \(form)")
		}

		var athleteJSON: [String: Any] = [
			"id": "redacted",
			"name": athlete.name,
		]
		if let ftp = athlete.ftp {
			athleteJSON["ftp"] = ftp
		}
		let payload: [String: Any] = [
			"athlete": athleteJSON,
			"wellness": wellness.map { day -> [String: Any] in
				var row: [String: Any] = ["date": day.date.rawValue]
				if let fitness = day.fitness { row["fitness"] = fitness }
				if let fatigue = day.fatigue { row["fatigue"] = fatigue }
				if let form = day.form { row["form"] = form }
				return row
			},
			"activities": activities.map { row -> [String: Any] in
				var json: [String: Any] = [
					"id": "redacted",
					"name": row.name,
					"date": row.date.rawValue,
					"durationS": row.durationS,
				]
				if let load = row.trainingLoad {
					json["trainingLoad"] = load
				}
				return json
			},
			"events": events.map { event -> [String: Any] in
				var json: [String: Any] = [
					"id": "redacted",
					"startDateLocal": event.startDateLocal,
					"name": event.name,
					"category": event.category,
					"coachCreated": event.coachCreated,
				]
				if let externalId = event.externalId {
					json["externalId"] = externalId
				}
				return json
			},
		]
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
		if let path = ProcessInfo.processInfo.environment["ENDURAGENT_LIVE_OUT"], !path.isEmpty {
			try data.write(to: URL(fileURLWithPath: path))
		}
	}
}

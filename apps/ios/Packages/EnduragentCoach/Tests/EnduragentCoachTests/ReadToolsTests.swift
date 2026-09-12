import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct ReadToolsTests {
	let intervals = FakeIntervalsClient(athleteName: "Ada Kovač", ftp: 250)
	let clock = FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")

	@Test func calculateZonesReturnsDesktopRows() async throws {
		let outcome = try await runtime().execute(
			name: .calculateZones,
			arguments: try JSONValue.parse(#"{"ftpWatts":280}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let json) = outcome, let rows = unwrapData(json).arrayValue else {
			Issue.record("expected zone rows")
			return
		}
		#expect(rows[0].objectFields["value"]?.stringValue == "< 154W")
		#expect(rows[3].objectFields["overlaps"]?.boolValue == true)
	}

	@Test func fetchActivitiesDaysSevenRecordsCall() async throws {
		intervals.activities = [
			.ride(name: "Sunday long ride", date: "1998-06-07", durationS: 7200, trainingLoad: 120),
			.ride(name: "Too old", date: "1998-05-01", durationS: 1800, trainingLoad: 40),
		]
		let outcome = try await runtime().execute(
			name: .intervalsFetchActivities,
			arguments: try JSONValue.parse(#"{"days":7}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(intervals.calls == [.activities(days: 7)])
		guard case .result(let json) = outcome, let rows = unwrapData(json).arrayValue else {
			Issue.record("expected activities")
			return
		}
		#expect(rows.map { $0.objectFields["name"]?.stringValue } == ["Sunday long ride"])
	}

	@Test func omittedNewestUsesAthleteTimeZoneToday() async throws {
		_ = try await runtime().execute(
			name: .intervalsFetchWellness,
			arguments: try JSONValue.parse(#"{"oldest":"1998-06-07"}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(intervals.calls == [.wellness(oldest: "1998-06-07", newest: "1998-06-13")])
	}

	@Test func wellnessToolOmitsCtlAtl() async throws {
		intervals.wellness = [
			WellnessDay(json: IntervalsWellnessJSON(
				date: "1998-06-13",
				ctl: 55.2,
				atl: 42.1,
				rampRate: 1.4,
				fatigue: 2
			)),
		]
		let outcome = try await runtime().execute(
			name: .intervalsFetchWellness,
			arguments: try JSONValue.parse(#"{"oldest":"1998-06-13","newest":"1998-06-13"}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let json) = outcome else {
			Issue.record("expected wellness")
			return
		}
		let encoded = canonicalJSON(unwrapData(json))
		#expect(!encoded.contains("\"ctl\""))
		#expect(!encoded.contains("\"atl\""))
		#expect(encoded.contains("\"fitness\""))
		#expect(encoded.contains("\"Fatigue\"") == false)
		#expect(unwrapData(json).arrayValue?.first?.objectFields["fatigue"]?.numberValue == 42.1)
		#expect(unwrapData(json).arrayValue?.first?.objectFields["form"]?.numberValue == 55.2 - 42.1)
	}

	@Test func fetchAthleteAndActivityAndStreamsAndEvents() async throws {
		let activityID = try #require(ActivityID(rawValue: "i1234567"))
		intervals.activity = try JSONValue.parse(#"{"id":"i1234567","name":"Sunday long ride"}"#)
		intervals.streams = try JSONValue.parse(String(data: try fixtureData("streams-ts"), encoding: .utf8)!)
		intervals.events = [
			CalendarEvent(
				id: EventID(rawValue: 42),
				startDateLocal: "1998-06-14T00:00:00",
				name: "Endurance",
				category: "WORKOUT",
				externalId: "cycling-coach:1998-06-14:endurance",
				uid: nil,
				tags: ["cycling-coach"],
				coachCreated: true
			),
			CalendarEvent(
				id: EventID(rawValue: 43),
				startDateLocal: "1998-06-20T00:00:00",
				name: "Local race",
				category: "RACE_A",
				externalId: nil,
				uid: nil,
				tags: [],
				coachCreated: false
			),
		]
		let tools = runtime()
		let athlete = try await tools.execute(
			name: .intervalsFetchAthlete,
			arguments: .object([:]),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let athleteJSON) = athlete else {
			Issue.record("expected athlete")
			return
		}
		#expect(unwrapData(athleteJSON).objectFields["name"]?.stringValue == "Ada Kovač")

		_ = try await tools.execute(
			name: .intervalsFetchActivity,
			arguments: try JSONValue.parse(#"{"activityId":"i1234567"}"#),
			chatId: .main,
			state: turnState()
		)
		_ = try await tools.execute(
			name: .intervalsFetchStreams,
			arguments: try JSONValue.parse(#"{"activityId":"i1234567"}"#),
			chatId: .main,
			state: turnState()
		)
		let listed = try await tools.execute(
			name: .intervalsListEvents,
			arguments: try JSONValue.parse(#"{"oldest":"1998-06-14","newest":"1998-06-20","coachCreatedOnly":true}"#),
			chatId: .main,
			state: turnState()
		)
		#expect(intervals.calls.contains(.activity(activityID)))
		#expect(intervals.calls.contains(.streams(activityID)))
		#expect(intervals.calls.contains(.events(oldest: "1998-06-14", newest: "1998-06-20")))
		guard case .result(let eventsJSON) = listed, let events = unwrapData(eventsJSON).arrayValue else {
			Issue.record("expected events")
			return
		}
		#expect(events.count == 1)
		#expect(events[0].objectFields["name"]?.stringValue == "Endurance")
	}

	@Test func rangeTooWideReturnsTypedError() async throws {
		let outcome = try await runtime().execute(
			name: .intervalsFetchActivities,
			arguments: try JSONValue.parse(#"{"oldest":"1998-01-01","newest":"1999-01-02"}"#),
			chatId: .main,
			state: turnState()
		)
		guard case .result(let json) = outcome else {
			Issue.record("expected error object")
			return
		}
		#expect(unwrapData(json).objectFields["error"]?.stringValue == "range_too_wide")
		#expect(intervals.calls.isEmpty)
	}

	@Test func toolsForTurnSchemasHaveNoUnions() {
		let schemas = runtime().toolsForTurn(chatId: .main, memory: MemoryView(
			sections: [:],
			todayNotes: nil,
			planHeadline: nil,
			orphanNames: []
		))
		#expect(
			schemas.map(\.name) == [
				.calculateZones,
				.intervalsFetchAthlete,
				.intervalsFetchWellness,
				.intervalsFetchActivity,
				.intervalsFetchStreams,
				.intervalsFetchActivities,
				.intervalsListEvents,
				.memoryQuery,
				.memoryWrite,
				.ledgerAppend,
			]
		)
		let encoded = schemas.map { canonicalJSON($0.parameters) }.joined()
		#expect(!encoded.contains("anyOf"))
		#expect(!encoded.contains("oneOf"))
		#expect(!encoded.contains("allOf"))
		#expect(schemas.contains { $0.description.contains("Form = fitness - fatigue") })
		#expect(WorkoutReview.windowDays == IntervalsPolicy.reviewWindowDays)
		#expect(WorkoutReview.windowDays == 7)
	}

	private func unwrapData(_ json: JSONValue) -> JSONValue {
		json.objectFields["data"] ?? json
	}

	private func runtime() -> ToolRuntime {
		let store = InMemoryRecordLog()
		return ToolRuntime(
			intervals: intervals,
			store: store,
			planning: Planning(store: store, intervals: intervals, clock: clock),
			clock: clock
		)
	}

	private func turnState() -> TurnState {
		TurnState(
			chatId: .main,
			messages: [],
			windowStart: nil,
			pending: nil,
			writesCommitted: 0,
			flushedThisTurn: false,
			lastFlushMessageCount: 0,
			steps: 0
		)
	}
}

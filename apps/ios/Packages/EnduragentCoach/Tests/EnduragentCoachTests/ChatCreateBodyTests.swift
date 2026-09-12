import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct ChatCreateBodyTests {
	@Test func emitsWireFieldsAndOmitsForbiddenKeys() throws {
		let workout = try IntervalsSerializer.parseWorkout(
			try JSONValue.parse(
				#"{"name":"Z2 Endurance 90min","steps":[{"type":"steady","duration":{"value":70,"unit":"minutes"},"power":{"kind":"percent_ftp","low":56,"high":75}}]}"#
			)
		)
		let serialized = try IntervalsSerializer.serialize(workout)
		let draft = ChatCalendarCreate(
			date: "1998-06-14",
			name: workout.name,
			description: serialized.description,
			type: .ride,
			externalId: IntervalsSerializer.chatExternalId(date: "1998-06-14", name: workout.name),
			tags: [IntervalsPolicy.coachTag]
		)
		let body = IntervalsPolicy.chatCreateBody(draft)
		let fields = body.objectFields
		#expect(fields["start_date_local"]?.stringValue == "1998-06-14T00:00:00")
		#expect(fields["category"]?.stringValue == "WORKOUT")
		#expect(fields["type"]?.stringValue == "Ride")
		#expect(fields["name"]?.stringValue == "Z2 Endurance 90min")
		#expect(fields["description"]?.stringValue == serialized.description)
		#expect(fields["external_id"]?.stringValue == "cycling-coach:1998-06-14:z2-endurance-90min")
		#expect(fields["tags"]?.arrayValue?.compactMap(\.stringValue) == ["cycling-coach"])
		#expect(fields["moving_time"] == nil)
		#expect(fields["icu_training_load"] == nil)
		#expect(fields["uid"] == nil)
		#expect(fields["workout_doc"] == nil)
		let encoded = canonicalJSON(body)
		#expect(!encoded.contains("moving_time"))
		#expect(!encoded.contains("icu_training_load"))
		#expect(!encoded.contains("\"uid\""))
		#expect(!encoded.contains("workout_doc"))
		try encoded.write(toFile: "/tmp/ios-c6/create-body-swift.json", atomically: true, encoding: .utf8)
		try encoded.write(toFile: "/tmp/ios-c6/create-body-ts.json", atomically: true, encoding: .utf8)
	}

	@Test func parseCreateWorkoutRefusesPastDates() throws {
		let today: CivilDate = "1998-06-13"
		let arguments = try JSONValue.parse(
			#"{"date":"1998-06-12","workout":{"name":"Endurance","steps":[{"type":"steady","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","value":60}}]}}"#
		)
		do {
			_ = try CyclingTools.parseCreateWorkout(arguments, today: today)
			Issue.record("expected past_date_refused")
		} catch let error as IntervalsError {
			#expect(error.code == "past_date_refused")
			#expect(error.details.contains("1998-06-12"))
			#expect(error.details.contains("1998-06-13"))
		}
	}

	@Test func parseCreateWorkoutAllowsTodayAndBuildsRide() throws {
		let arguments = try JSONValue.parse(
			#"{"date":"1998-06-13","workout":{"name":"Endurance","steps":[{"type":"warmup","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","low":55,"high":65}}]}}"#
		)
		let draft = try CyclingTools.parseCreateWorkout(arguments, today: "1998-06-13")
		#expect(draft.type == .ride)
		#expect(draft.tags == ["cycling-coach"])
		#expect(draft.externalId.rawValue == "cycling-coach:1998-06-13:endurance")
		#expect(draft.description.hasPrefix("Warmup\n- 10m 55-65%"))
	}
}

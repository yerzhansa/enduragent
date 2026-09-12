import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct SerializerTests {
	@Test func matchesDesktopCases() throws {
		let data = try fixtureData("serializer-cases")
		let root = try JSONValue.parse(String(data: data, encoding: .utf8)!)
		guard let cases = root.arrayValue else {
			Issue.record("serializer-cases.json must be an array")
			return
		}
		var mismatches: [String] = []
		for item in cases {
			let fields = item.objectFields
			guard let id = fields["id"]?.stringValue, let input = fields["input"] else {
				mismatches.append("missing id or input")
				continue
			}
			let expectedError = fields["error"]?.stringValue
			do {
				let workout = try IntervalsSerializer.parseWorkout(input)
				let serialized = try IntervalsSerializer.serialize(workout)
				if expectedError != nil {
					mismatches.append("\(id): expected error, got description")
					continue
				}
				let expectedDescription = fields["description"]?.stringValue ?? ""
				if serialized.description != expectedDescription {
					mismatches.append("\(id): description mismatch")
				}
				if serialized.description.utf8.elementsEqual(expectedDescription.utf8) == false {
					mismatches.append("\(id): description bytes mismatch")
				}
				let expectedTime = fields["movingTime"]?.intValue()
				if serialized.movingTime != expectedTime {
					mismatches.append("\(id): movingTime \(serialized.movingTime) != \(expectedTime as Any)")
				}
			} catch is InvalidWorkout {
				if expectedError == nil {
					mismatches.append("\(id): unexpected InvalidWorkout")
				}
			} catch {
				mismatches.append("\(id): \(error)")
			}
		}
		#expect(mismatches.isEmpty, "\(mismatches.joined(separator: "; "))")
		let report = mismatches.isEmpty ? "0 mismatches across \(cases.count) cases\n" : mismatches.joined(separator: "\n") + "\n"
		try? report.write(toFile: "/tmp/ios-c6/serializer-swift-report.txt", atomically: true, encoding: .utf8)
	}

	@Test func ftp280DisplayGapIsUnchanged() throws {
		let rows = try DisplayZones.calculate(ftpWatts: 280)
		#expect(rows[0] == "< 154W")
		#expect(rows[1] == "157-210W")
	}

	@Test func slugifyMatchesDesktop() {
		#expect(ChatExternalID.slugify(name: "Z2 Endurance 90min") == "z2-endurance-90min")
		#expect(ChatExternalID.slugify(name: "Endurance") == "endurance")
		#expect(ChatExternalID.slugify(name: "---") == "workout")
		#expect(ChatExternalID.slugify(name: "") == "workout")
		let long = String(repeating: "a", count: 50)
		#expect(ChatExternalID.slugify(name: long).count == 40)
		#expect(IntervalsSerializer.slug(date: "1998-06-14", name: "Endurance") == "endurance")
	}

	@Test func eachCapThrows() {
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "", steps: [
					.simple(SimpleStep(type: .steady, duration: DurationInput(value: 1, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 50, low: nil, high: nil), cadence: nil, label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			let step = WorkoutStep.simple(SimpleStep(type: .steady, duration: DurationInput(value: 1, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 65, low: nil, high: nil), cadence: nil, label: nil))
			_ = try IntervalsSerializer.serialize(IntervalsWorkoutInput(name: "Too many", steps: Array(repeating: step, count: 41)))
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Repeat", steps: [
					.set(SetStep(
						repeatCount: 21,
						interval: SimpleStep(type: .interval, duration: DurationInput(value: 1, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 110, low: nil, high: nil), cadence: nil, label: nil),
						recovery: SimpleStep(type: .recovery, duration: DurationInput(value: 1, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 50, low: nil, high: nil), cadence: nil, label: nil)
					)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Watts", steps: [
					.simple(SimpleStep(type: .interval, duration: DurationInput(value: 5, unit: .seconds), power: PowerTarget(kind: .watts, value: 2000, low: nil, high: nil), cadence: nil, label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Percent", steps: [
					.simple(SimpleStep(type: .interval, duration: DurationInput(value: 30, unit: .seconds), power: PowerTarget(kind: .percentFtp, value: 250, low: nil, high: nil), cadence: nil, label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Zone", steps: [
					.simple(SimpleStep(type: .steady, duration: DurationInput(value: 30, unit: .minutes), power: PowerTarget(kind: .zone, value: 8, low: nil, high: nil), cadence: nil, label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Inverted", steps: [
					.simple(SimpleStep(type: .steady, duration: DurationInput(value: 30, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: nil, low: 90, high: 70), cadence: nil, label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Cadence", steps: [
					.simple(SimpleStep(type: .steady, duration: DurationInput(value: 30, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 65, low: nil, high: nil), cadence: CadenceTarget(value: nil, low: 90, high: nil), label: nil)),
				])
			)
		}
		#expect(throws: InvalidWorkout.self) {
			_ = try IntervalsSerializer.serialize(
				IntervalsWorkoutInput(name: "Ramp", steps: [
					.simple(SimpleStep(type: .ramp, duration: DurationInput(value: 10, unit: .minutes), power: PowerTarget(kind: .percentFtp, value: 70, low: nil, high: nil), cadence: nil, label: nil)),
				])
			)
		}
	}

	@Test func formatDurationMatchesGrammar() {
		#expect(IntervalsSerializer.formatDuration(DurationInput(value: 30, unit: .seconds)) == "30s")
		#expect(IntervalsSerializer.formatDuration(DurationInput(value: 60, unit: .seconds)) == "1m")
		#expect(IntervalsSerializer.formatDuration(DurationInput(value: 90, unit: .seconds)) == "1m30")
		#expect(IntervalsSerializer.formatDuration(DurationInput(value: 61, unit: .seconds)) == "1m1")
		#expect(IntervalsSerializer.formatDuration(DurationInput(value: 10, unit: .minutes)) == "10m")
	}
}

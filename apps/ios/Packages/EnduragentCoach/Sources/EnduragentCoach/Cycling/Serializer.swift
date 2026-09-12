import Foundation

public enum StepType: String, Sendable {
	case warmup
	case cooldown
	case set
	case ramp
	case freeride
	case rest
	case interval
}

public enum PowerKind: String, Sendable {
	case watts
	case percentFtp = "percent_ftp"
	case zone
}

public struct DurationInput: Sendable, Equatable {
	public var value: Double
	public var unit: Unit

	public enum Unit: String, Sendable {
		case seconds
		case minutes
	}
}

public struct PowerTarget: Sendable, Equatable {
	public var kind: PowerKind
	public var value: Double?
	public var low: Double?
	public var high: Double?
}

public struct CadenceTarget: Sendable, Equatable {
	public var value: Int?
	public var low: Int?
	public var high: Int?
}

public struct SimpleStep: Sendable, Equatable {
	public var type: StepType
	public var duration: DurationInput
	public var power: PowerTarget?
	public var cadence: CadenceTarget?
	public var label: String?
}

public struct SetStep: Sendable, Equatable {
	public var repeatCount: Int
	public var interval: SimpleStep
	public var recovery: SimpleStep
}

public enum WorkoutStep: Sendable, Equatable {
	case simple(SimpleStep)
	case set(SetStep)
}

public struct IntervalsWorkoutInput: Sendable, Equatable {
	public var name: String
	public var steps: [WorkoutStep]
}

public struct SerializedWorkout: Sendable, Equatable {
	public var description: String
	public var movingTime: Int
}

public struct InvalidWorkout: Error, Sendable {
	public var message: String
}

public enum ZoneMidpoints {
	public static let values: [Int: Double] = [
		1: 0.45, 2: 0.65, 3: 0.83, 4: 0.98, 5: 1.13, 6: 1.355, 7: 1.6,
	]
}

public enum IntervalsSerializer {
	public static let maxWatts = 1500
	public static let maxPercentFtp = 200
	public static let maxSteps = 40
	public static let maxRepeat = 20

	public static func serialize(_ workout: IntervalsWorkoutInput) throws -> SerializedWorkout {
		fatalError("not implemented")
	}

	public static func formatDuration(_ duration: DurationInput) -> String {
		fatalError("not implemented")
	}

	public static func slug(date: CivilDate, name: String) -> String {
		fatalError("not implemented")
	}

	public static func chatExternalId(date: CivilDate, name: String) -> ChatExternalID {
		ChatExternalID(date: date, slug: slug(date: date, name: name))
	}
}

public enum DisplayZones {
	public static func calculate(ftpWatts: Int) throws -> [String] {
		try table(ftpWatts: ftpWatts).map(\.value)
	}

	package struct Row: Sendable, Equatable {
		package var label: String
		package var value: String
		package var overlaps: Bool
	}

	package static func table(ftpWatts: Int) throws -> [Row] {
		guard IntervalsPolicy.ftpRange.contains(ftpWatts) else {
			throw IntervalsError(
				code: "invalid_ftp",
				details: "FTP must be between 50 and 600 watts."
			)
		}
		func band(_ fraction: Double) -> Int {
			Int((Double(ftpWatts) * fraction).rounded())
		}
		return [
			Row(label: "Z1 Active Recovery", value: "< \(band(0.55))W", overlaps: false),
			Row(label: "Z2 Endurance", value: "\(band(0.56))-\(band(0.75))W", overlaps: false),
			Row(label: "Z3 Tempo", value: "\(band(0.76))-\(band(0.9))W", overlaps: false),
			Row(label: "Sweet Spot (88-94%)", value: "\(band(0.88))-\(band(0.94))W", overlaps: true),
			Row(label: "Z4 Threshold", value: "\(band(0.91))-\(band(1.05))W", overlaps: false),
			Row(label: "Z5 VO2max", value: "\(band(1.06))-\(band(1.2))W", overlaps: false),
		]
	}

	package static func json(ftpWatts: [Int]) throws -> JSONValue {
		var object: [String: JSONValue] = [:]
		for ftp in ftpWatts {
			object[String(ftp)] = .array(try table(ftpWatts: ftp).map { row in
				var fields: [String: JSONValue] = [
					"label": .string(row.label),
					"value": .string(row.value),
				]
				if row.overlaps {
					fields["overlaps"] = .bool(true)
				}
				return .object(fields)
			})
		}
		return .object(object)
	}
}

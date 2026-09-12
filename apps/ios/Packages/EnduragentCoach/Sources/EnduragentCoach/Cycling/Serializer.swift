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
		fatalError("not implemented")
	}
}

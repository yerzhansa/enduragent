import Foundation

public enum StepType: String, Sendable {
	case warmup
	case cooldown
	case set
	case ramp
	case freeride
	case rest
	case interval
	case steady
	case recovery
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

public struct InvalidWorkout: Error, Sendable, Equatable {
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
	private static let maxZone = 7
	private static let minZone = 1
	private static let maxName = 120

	public static func serialize(_ workout: IntervalsWorkoutInput) throws -> SerializedWorkout {
		try validateSchema(workout)
		try workout.steps.enumerated().forEach { index, step in
			try preValidate(step, path: "steps[\(index)]")
		}

		var lines: [String] = []
		var currentLabel: String?

		for (index, step) in workout.steps.enumerated() {
			let label = sectionLabel(for: step)
			if label != currentLabel {
				if !lines.isEmpty {
					lines.append("")
				}
				lines.append(label)
				currentLabel = label
			}
			let path = "steps[\(index)]"
			switch step {
			case .set(let set):
				lines.append("\(set.repeatCount)x")
				lines.append(try formatStepLine(set.interval, path: "\(path).interval"))
				lines.append(try formatStepLine(set.recovery, path: "\(path).recovery"))
			case .simple(let simple):
				lines.append(try formatStepLine(simple, path: path))
			}
		}

		return SerializedWorkout(
			description: lines.joined(separator: "\n"),
			movingTime: totalSeconds(workout.steps)
		)
	}

	public static func formatDuration(_ duration: DurationInput) -> String {
		let total = Int(toSeconds(duration).rounded())
		if total < 60 {
			return "\(total)s"
		}
		let minutes = total / 60
		let seconds = total % 60
		return seconds == 0 ? "\(minutes)m" : "\(minutes)m\(seconds)"
	}

	public static func slug(date: CivilDate, name: String) -> String {
		_ = date
		return ChatExternalID.slugify(name: name)
	}

	public static func chatExternalId(date: CivilDate, name: String) -> ChatExternalID {
		ChatExternalID(date: date, slug: slug(date: date, name: name))
	}

	package static func parseWorkout(_ json: JSONValue) throws -> IntervalsWorkoutInput {
		let fields = json.objectFields
		guard let name = fields["name"]?.stringValue else {
			throw InvalidWorkout(message: "name: Required")
		}
		guard let stepsJSON = fields["steps"]?.arrayValue else {
			throw InvalidWorkout(message: "steps: Required")
		}
		let steps = try stepsJSON.enumerated().map { index, value in
			try parseStep(value, path: "steps[\(index)]")
		}
		return IntervalsWorkoutInput(name: name, steps: steps)
	}

	private static func validateSchema(_ workout: IntervalsWorkoutInput) throws {
		if workout.name.isEmpty || workout.name.count > maxName {
			throw InvalidWorkout(message: "name: String must contain at most \(maxName) character(s)")
		}
		if workout.steps.isEmpty {
			throw InvalidWorkout(message: "steps: Array must contain at least 1 element(s)")
		}
		if workout.steps.count > maxSteps {
			throw InvalidWorkout(message: "steps: Array must contain at most \(maxSteps) element(s)")
		}
		for (index, step) in workout.steps.enumerated() {
			if case .set(let set) = step {
				if set.repeatCount < 1 || set.repeatCount > maxRepeat {
					throw InvalidWorkout(message: "steps[\(index)].repeat: Number must be less than or equal to \(maxRepeat)")
				}
			}
		}
	}

	private static func preValidate(_ step: WorkoutStep, path: String) throws {
		switch step {
		case .set(let set):
			try preValidate(.simple(set.interval), path: "\(path).interval")
			try preValidate(.simple(set.recovery), path: "\(path).recovery")
		case .simple(let simple):
			if simple.type == .ramp && simple.power == nil {
				throw InvalidWorkout(message: "\(path): ramp step requires a power target")
			}
			if let power = simple.power {
				try validatePowerBounds(power, path: path)
			}
			if let label = simple.label, label.count > maxName {
				throw InvalidWorkout(message: "\(path).label: String must contain at most \(maxName) character(s)")
			}
			if simple.duration.value <= 0 {
				throw InvalidWorkout(message: "\(path).duration.value: Number must be greater than 0")
			}
		}
	}

	private static func validatePowerBounds(_ power: PowerTarget, path: String) throws {
		func check(_ value: Double?, name: String) throws {
			guard let value else { return }
			if power.kind == .watts, value > Double(maxWatts) {
				throw InvalidWorkout(message: "\(path).power.\(name): \(jsString(value))w exceeds sanity bound \(maxWatts)w")
			}
			if power.kind == .percentFtp, value > Double(maxPercentFtp) {
				throw InvalidWorkout(message: "\(path).power.\(name): \(jsString(value))% exceeds sanity bound \(maxPercentFtp)%")
			}
		}
		try check(power.value, name: "value")
		try check(power.low, name: "low")
		try check(power.high, name: "high")
	}

	private static func formatPower(_ power: PowerTarget, isRamp: Bool, path: String) throws -> String {
		let hasRange = power.low != nil && power.high != nil
		let hasValue = power.value != nil
		let prefix = isRamp ? "ramp " : ""
		if isRamp && !hasRange {
			throw InvalidWorkout(message: "\(path): ramp requires power.low and power.high")
		}
		if hasRange {
			let low = power.low!
			let high = power.high!
			if low > high {
				throw InvalidWorkout(message: "\(path): power.low (\(jsString(low))) > power.high (\(jsString(high)))")
			}
			if power.kind == .zone {
				try assertZone(low, path: "\(path).power.low")
				try assertZone(high, path: "\(path).power.high")
				if isRamp {
					let lowPct = Int((ZoneMidpoints.values[Int(low)]! * 100).rounded())
					let highPct = Int((ZoneMidpoints.values[Int(high)]! * 100).rounded())
					return "\(prefix)\(lowPct)-\(highPct)%"
				}
				return "Z\(jsString(low))-Z\(jsString(high))"
			}
			if power.kind == .percentFtp {
				return "\(prefix)\(jsString(low))-\(jsString(high))%"
			}
			return "\(prefix)\(jsString(low))-\(jsString(high))w"
		}
		if hasValue {
			let value = power.value!
			if power.kind == .zone {
				try assertZone(value, path: "\(path).power.value")
				return "Z\(jsString(value))"
			}
			if power.kind == .percentFtp {
				return "\(jsString(value))%"
			}
			return "\(jsString(value))w"
		}
		throw InvalidWorkout(message: "\(path): power requires 'value' or 'low'+'high'")
	}

	private static func formatCadence(_ cadence: CadenceTarget, path: String) throws -> String {
		let hasTarget = cadence.value != nil
		let hasLow = cadence.low != nil
		let hasHigh = cadence.high != nil
		if hasLow != hasHigh {
			throw InvalidWorkout(message: "\(path): cadence range requires both 'low' and 'high'")
		}
		if hasLow && hasHigh {
			let low = cadence.low!
			let high = cadence.high!
			if low > high {
				throw InvalidWorkout(message: "\(path): cadence.low (\(low)) > cadence.high (\(high))")
			}
			return "\(low)-\(high)rpm"
		}
		if hasTarget {
			return "\(cadence.value!)rpm"
		}
		throw InvalidWorkout(message: "\(path): cadence requires 'target' or 'low'+'high'")
	}

	private static func formatStepLine(_ step: SimpleStep, path: String) throws -> String {
		var parts = [formatDuration(step.duration)]
		if let power = step.power {
			parts.append(try formatPower(power, isRamp: step.type == .ramp, path: path))
		}
		if let cadence = step.cadence {
			parts.append(try formatCadence(cadence, path: path))
		}
		let body = parts.joined(separator: " ")
		if let label = step.label {
			return "- \(body) \(label)"
		}
		return "- \(body)"
	}

	private static func sectionLabel(for step: WorkoutStep) -> String {
		switch step {
		case .set:
			return "Main set"
		case .simple(let simple):
			if simple.type == .warmup { return "Warmup" }
			if simple.type == .cooldown { return "Cooldown" }
			return "Main set"
		}
	}

	private static func toSeconds(_ duration: DurationInput) -> Double {
		duration.unit == .seconds ? duration.value : duration.value * 60
	}

	private static func totalSeconds(_ steps: [WorkoutStep]) -> Int {
		var total = 0.0
		func visit(_ step: WorkoutStep, multiplier: Double) {
			switch step {
			case .set(let set):
				visit(.simple(set.interval), multiplier: multiplier * Double(set.repeatCount))
				visit(.simple(set.recovery), multiplier: multiplier * Double(set.repeatCount))
			case .simple(let simple):
				total += toSeconds(simple.duration) * multiplier
			}
		}
		for step in steps {
			visit(step, multiplier: 1)
		}
		return Int(total.rounded())
	}

	private static func assertZone(_ value: Double, path: String) throws {
		let integer = value.rounded() == value
		if !integer || value < Double(minZone) || value > Double(maxZone) {
			throw InvalidWorkout(message: "\(path): zone must be an integer \(minZone)-\(maxZone), got \(jsString(value))")
		}
	}

	private static func parseStep(_ json: JSONValue, path: String) throws -> WorkoutStep {
		let fields = json.objectFields
		let type = fields["type"]?.stringValue
		if type == "set" {
			let repeatCount = fields["repeat"]?.intValue() ?? fields["repeatCount"]?.intValue()
			guard let repeatCount else {
				throw InvalidWorkout(message: "\(path).repeat: Required")
			}
			guard let intervalJSON = fields["interval"] else {
				throw InvalidWorkout(message: "\(path).interval: Required")
			}
			guard let recoveryJSON = fields["recovery"] else {
				throw InvalidWorkout(message: "\(path).recovery: Required")
			}
			return .set(
				SetStep(
					repeatCount: repeatCount,
					interval: try parseSimple(intervalJSON, path: "\(path).interval"),
					recovery: try parseSimple(recoveryJSON, path: "\(path).recovery")
				)
			)
		}
		return .simple(try parseSimple(json, path: path))
	}

	private static func parseSimple(_ json: JSONValue, path: String) throws -> SimpleStep {
		let fields = json.objectFields
		guard let typeRaw = fields["type"]?.stringValue, let type = StepType(rawValue: typeRaw), type != .set else {
			throw InvalidWorkout(message: "\(path).type: Invalid option")
		}
		guard let durationJSON = fields["duration"] else {
			throw InvalidWorkout(message: "\(path).duration: Required")
		}
		return SimpleStep(
			type: type,
			duration: try parseDuration(durationJSON, path: "\(path).duration"),
			power: try fields["power"].map { try parsePower($0, path: "\(path).power") },
			cadence: try fields["cadence"].map { try parseCadence($0, path: "\(path).cadence") },
			label: fields["label"]?.stringValue
		)
	}

	private static func parseDuration(_ json: JSONValue, path: String) throws -> DurationInput {
		let fields = json.objectFields
		guard let value = fields["value"]?.numberValue else {
			throw InvalidWorkout(message: "\(path).value: Required")
		}
		guard let unitRaw = fields["unit"]?.stringValue, let unit = DurationInput.Unit(rawValue: unitRaw) else {
			throw InvalidWorkout(message: "\(path).unit: Invalid option")
		}
		return DurationInput(value: value, unit: unit)
	}

	private static func parsePower(_ json: JSONValue, path: String) throws -> PowerTarget {
		let fields = json.objectFields
		guard let kindRaw = fields["kind"]?.stringValue, let kind = PowerKind(rawValue: kindRaw) else {
			throw InvalidWorkout(message: "\(path).kind: Invalid option")
		}
		return PowerTarget(
			kind: kind,
			value: fields["value"]?.numberValue,
			low: fields["low"]?.numberValue,
			high: fields["high"]?.numberValue
		)
	}

	private static func parseCadence(_ json: JSONValue, path: String) throws -> CadenceTarget {
		_ = path
		let fields = json.objectFields
		let target = fields["target"]?.intValue() ?? fields["value"]?.intValue()
		return CadenceTarget(
			value: target,
			low: fields["low"]?.intValue(),
			high: fields["high"]?.intValue()
		)
	}

	private static func jsString(_ value: Double) -> String {
		if value.isFinite, value.rounded(.towardZero) == value, abs(value) <= 9_007_199_254_740_991 {
			return String(Int64(value))
		}
		return String(value)
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

import Foundation

public struct ActivityID: Hashable, Sendable {
	public let rawValue: String

	public init?(rawValue: String) {
		let digits = rawValue.allSatisfy(\.isNumber)
		let prefixed = rawValue.first == "i" && rawValue.dropFirst().allSatisfy(\.isNumber)
		let hex = rawValue.count == 64 && rawValue.allSatisfy { $0.isHexDigit && !$0.isUppercase }
		guard digits || prefixed || hex else { return nil }
		self.rawValue = rawValue
	}
}

public struct EventID: Hashable, Sendable {
	public let rawValue: Int
	public init(rawValue: Int) { self.rawValue = rawValue }
}

public struct ChatExternalID: Hashable, Sendable {
	public var date: CivilDate
	public var slug: String

	public var rawValue: String {
		"cycling-coach:\(date):\(slug)"
	}

	public static func slugify(name: String) -> String {
		fatalError("not implemented")
	}
}

public struct PlanMirrorUID: Hashable, Sendable {
	public var planId: ULID
	public var workoutId: ULID

	public var rawValue: String {
		"cycling-coach:plan:\(planId.rawValue):\(workoutId.rawValue)"
	}
}

public struct AthleteProfile: Sendable, Equatable {
	public var id: String
	public var name: String
	public var ftp: Int?
}

package struct IntervalsWellnessJSON: Sendable, Equatable, Decodable {
	package var date: CivilDate
	package var ctl: Double?
	package var atl: Double?
	package var rampRate: Double?
	package var fatigue: Int?

	private enum CodingKeys: String, CodingKey {
		case id
		case ctl
		case atl
		case rampRate = "ramp_rate"
		case fatigue
	}

	package init(date: CivilDate, ctl: Double?, atl: Double?, rampRate: Double?, fatigue: Int?) {
		self.date = date
		self.ctl = ctl
		self.atl = atl
		self.rampRate = rampRate
		self.fatigue = fatigue
	}

	package init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		let id = try container.decode(String.self, forKey: .id)
		guard let date = CivilDate(rawValue: id) else {
			throw DecodingError.dataCorruptedError(
				forKey: .id,
				in: container,
				debugDescription: "invalid civil date"
			)
		}
		self.date = date
		self.ctl = try container.decodeIfPresent(Double.self, forKey: .ctl)
		self.atl = try container.decodeIfPresent(Double.self, forKey: .atl)
		self.rampRate = try container.decodeIfPresent(Double.self, forKey: .rampRate)
		self.fatigue = try container.decodeIfPresent(Int.self, forKey: .fatigue)
	}
}

public struct WellnessDay: Sendable, Equatable {
	public var date: CivilDate
	public var fitness: Double?
	public var fatigue: Double?
	public var form: Double?

	public init(date: CivilDate, fitness: Double?, fatigue: Double?, form: Double?) {
		self.date = date
		self.fitness = fitness
		self.fatigue = fatigue
		self.form = form
	}

	package init(json: IntervalsWellnessJSON) {
		self.date = json.date
		self.fitness = json.ctl
		self.fatigue = json.atl
		if let fitness = json.ctl, let fatigue = json.atl {
			self.form = fitness - fatigue
		} else {
			self.form = nil
		}
	}
}

public struct ActivitySummary: Sendable, Equatable {
	public var name: String
	public var date: CivilDate
	public var durationS: Int
	public var trainingLoad: Int?

	public static func ride(name: String, date: String, durationS: Int, trainingLoad: Int) -> ActivitySummary {
		ActivitySummary(
			name: name,
			date: CivilDate(stringLiteral: date),
			durationS: durationS,
			trainingLoad: trainingLoad
		)
	}
}

public struct CalendarEvent: Sendable, Equatable {
	public var id: EventID
	public var startDateLocal: String
	public var name: String
	public var category: String
	public var externalId: String?
	public var uid: String?
	public var tags: [String]
	public var coachCreated: Bool
}

public struct ChatCalendarCreate: Sendable, Equatable {
	public var date: CivilDate
	public var name: String
	public var description: String
	public var type: CalendarEventType
	public var externalId: ChatExternalID
	public var tags: [String]
}

public enum CalendarEventType: String, Sendable {
	case ride = "Ride"
	case weightTraining = "WeightTraining"
}

public struct PlanMirrorCreate: Sendable, Equatable {
	public var date: DateKey
	public var name: String
	public var description: String
	public var movingTime: Int
	public var uid: PlanMirrorUID
	public var workoutDoc: JSONValue
}

public protocol IntervalsClient: Sendable {
	func fetchAthlete() async throws -> AthleteProfile
	func fetchWellness(oldest: CivilDate, newest: CivilDate) async throws -> [WellnessDay]
	func fetchActivities(oldest: CivilDate, newest: CivilDate) async throws -> [ActivitySummary]
	func fetchActivity(id: ActivityID) async throws -> JSONValue
	func fetchStreams(id: ActivityID) async throws -> JSONValue
	func listEvents(oldest: CivilDate, newest: CivilDate) async throws -> [CalendarEvent]
	func createChatEvent(_ draft: ChatCalendarCreate) async throws -> CalendarEvent
	func createOrUpdatePlanEvent(_ draft: PlanMirrorCreate) async throws -> CalendarEvent
	func updateEvent(id: EventID, name: String?, description: String?, date: CivilDate?) async throws -> CalendarEvent
	func deleteEvent(id: EventID) async throws
}

public struct IntervalsError: Error, Sendable, Equatable {
	public var code: String
	public var details: String
	public var status: Int?

	public init(code: String, details: String, status: Int? = nil) {
		self.code = code
		self.details = details
		self.status = status
	}

	package var json: JSONValue {
		var fields: [String: JSONValue] = [
			"error": .string(code),
			"details": .string(details),
		]
		if let status {
			fields["status"] = .number(Double(status))
		}
		return .object(fields)
	}
}

public enum IntervalsPolicy {
	public static let listMaxRangeDays = 366
	public static let reviewWindowDays = 7
	public static let athletePath = "0"
	public static let baseURL = URL(string: "https://intervals.icu/api/v1")!
	public static let coachTag = "cycling-coach"
	public static let formRecoveryThreshold = -30.0
	public static let ftpRange = 50...600
	public static let requestTimeout: TimeInterval = 30
	public static let defaultStreamTypes = ["watts", "heartrate", "cadence", "time", "altitude"]
	public static let eventCategories = ["WORKOUT", "RACE_A", "RACE_B", "RACE_C"]

	public static func chatCreateBody(_ draft: ChatCalendarCreate) -> JSONValue {
		fatalError("not implemented")
	}

	package static func today(now: Date, timeZone: TimeZone) -> CivilDate {
		var calendar = Calendar(identifier: .gregorian)
		calendar.locale = Locale(identifier: "en_US_POSIX")
		calendar.timeZone = timeZone
		let parts = calendar.dateComponents([.year, .month, .day], from: now)
		let formatted = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
		return CivilDate(rawValue: formatted)!
	}

	package static func inclusiveDayCount(from oldest: CivilDate, to newest: CivilDate) -> Int {
		if oldest > newest { return 0 }
		var count = 1
		var cursor = oldest
		while cursor < newest {
			cursor = cursor.adding(days: 1)
			count += 1
		}
		return count
	}

	package static func rejectListRange(oldest: CivilDate, newest: CivilDate) throws {
		if oldest > newest {
			throw IntervalsError(
				code: "invalid_range",
				details: "oldest (\(oldest)) is after newest (\(newest)). Swap the bounds."
			)
		}
		let days = inclusiveDayCount(from: oldest, to: newest)
		if days > listMaxRangeDays {
			throw IntervalsError(
				code: "range_too_wide",
				details: "Range is \(days) days; the maximum is \(listMaxRangeDays). Fetch the range in chunks of at most \(listMaxRangeDays) days."
			)
		}
	}

	package static func isCoachOwned(externalId: String?, tags: [String]) -> Bool {
		if tags.contains(coachTag) { return true }
		if let externalId, externalId.hasPrefix("\(coachTag):") { return true }
		return false
	}
}

public enum CyclingTools {
	public static func parseCreateWorkout(_ arguments: JSONValue, today: CivilDate) throws -> ChatCalendarCreate {
		fatalError("not implemented")
	}
}

extension JSONValue {
	package var objectFields: [String: JSONValue] {
		if case .object(let fields) = self { return fields }
		return [:]
	}

	package var arrayValue: [JSONValue]? {
		if case .array(let items) = self { return items }
		return nil
	}

	package var stringValue: String? {
		if case .string(let value) = self { return value }
		return nil
	}

	package var numberValue: Double? {
		if case .number(let value) = self { return value }
		return nil
	}

	package var boolValue: Bool? {
		if case .bool(let value) = self { return value }
		return nil
	}

	package func intValue() -> Int? {
		switch self {
		case .number(let value) where value.rounded(.towardZero) == value:
			return Int(value)
		case .string(let value):
			return Int(value)
		default:
			return nil
		}
	}
}

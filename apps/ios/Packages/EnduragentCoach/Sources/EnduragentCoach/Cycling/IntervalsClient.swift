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

package struct IntervalsWellnessJSON: Sendable, Equatable {
	package var date: CivilDate
	package var ctl: Double?
	package var atl: Double?
	package var rampRate: Double?
	package var fatigue: Int?
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

public enum IntervalsPolicy {
	public static let listMaxRangeDays = 366
	public static let reviewWindowDays = 7
	public static let athletePath = "0"
	public static let baseURL = URL(string: "https://intervals.icu/api/v1")!
	public static let coachTag = "cycling-coach"
	public static let formRecoveryThreshold = -30.0
	public static let ftpRange = 50...600

	public static func chatCreateBody(_ draft: ChatCalendarCreate) -> JSONValue {
		fatalError("not implemented")
	}
}

public enum CyclingTools {
	public static func parseCreateWorkout(_ arguments: JSONValue, today: CivilDate) throws -> ChatCalendarCreate {
		fatalError("not implemented")
	}
}

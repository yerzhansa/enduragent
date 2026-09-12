import Foundation

public enum ScriptedEvent: Sendable, Equatable {
	case text(String)
	case toolCall(name: String, arguments: String)
	case finish(reason: FinishReason)
}

public final class FakeModelTransport: ModelTransport, @unchecked Sendable {
	public var script: [ScriptedEvent]
	public private(set) var requests: [CompletionRequest]

	public init() {
		self.script = []
		self.requests = []
	}

	public func stream(_ request: CompletionRequest) -> AsyncThrowingStream<TransportEvent, Error> {
		fatalError("not implemented")
	}
}

public enum FakeIntervalsCall: Sendable, Equatable {
	case activities(days: Int)
	case createEvent(date: CivilDate, externalId: String)
}

public final class FakeIntervalsClient: IntervalsClient, @unchecked Sendable {
	public var activities: [ActivitySummary]
	public private(set) var calls: [FakeIntervalsCall]
	public var athleteName: String
	public var ftp: Int

	public init(athleteName: String, ftp: Int) {
		self.athleteName = athleteName
		self.ftp = ftp
		self.activities = []
		self.calls = []
	}

	public func fetchAthlete() async throws -> AthleteProfile {
		AthleteProfile(id: "0", name: athleteName, ftp: ftp)
	}

	public func fetchWellness(oldest: CivilDate, newest: CivilDate) async throws -> [WellnessDay] {
		fatalError("not implemented")
	}

	public func fetchActivities(oldest: CivilDate, newest: CivilDate) async throws -> [ActivitySummary] {
		fatalError("not implemented")
	}

	public func fetchActivity(id: ActivityID) async throws -> JSONValue {
		fatalError("not implemented")
	}

	public func fetchStreams(id: ActivityID) async throws -> JSONValue {
		fatalError("not implemented")
	}

	public func listEvents(oldest: CivilDate, newest: CivilDate) async throws -> [CalendarEvent] {
		fatalError("not implemented")
	}

	public func createChatEvent(_ draft: ChatCalendarCreate) async throws -> CalendarEvent {
		fatalError("not implemented")
	}

	public func createOrUpdatePlanEvent(_ draft: PlanMirrorCreate) async throws -> CalendarEvent {
		fatalError("not implemented")
	}

	public func updateEvent(id: EventID, name: String?, description: String?, date: CivilDate?) async throws -> CalendarEvent {
		fatalError("not implemented")
	}

	public func deleteEvent(id: EventID) async throws {
		fatalError("not implemented")
	}
}

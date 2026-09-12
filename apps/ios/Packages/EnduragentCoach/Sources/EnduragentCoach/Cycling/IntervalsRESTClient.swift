import Foundation

public struct IntervalsRESTClient: IntervalsClient, Sendable {
	private let credential: IntervalsCredential
	private let session: URLSession
	private let athletePath: String
	private let clock: any Clock

	public init(credential: IntervalsCredential, session: URLSession? = nil, clock: any Clock = SystemClock()) {
		self.credential = credential
		self.athletePath = IntervalsPolicy.athletePath
		self.clock = clock
		if let session {
			self.session = session
		} else {
			let configuration = URLSessionConfiguration.ephemeral
			configuration.timeoutIntervalForRequest = IntervalsPolicy.requestTimeout
			configuration.timeoutIntervalForResource = IntervalsPolicy.requestTimeout
			self.session = URLSession(configuration: configuration)
		}
	}

	public func fetchAthlete() async throws -> AthleteProfile {
		let json = try await getJSON(path: ["athlete", athletePath])
		let fields = json.objectFields
		return AthleteProfile(
			id: fields["id"]?.stringValue ?? athletePath,
			name: fields["name"]?.stringValue ?? "",
			ftp: fields["icu_ftp"]?.intValue() ?? fields["icuFtp"]?.intValue()
		)
	}

	public func fetchWellness(oldest: CivilDate, newest: CivilDate) async throws -> [WellnessDay] {
		try IntervalsPolicy.rejectListRange(oldest: oldest, newest: newest)
		let data = try await get(
			path: ["athlete", athletePath, "wellness"],
			query: [
				URLQueryItem(name: "oldest", value: oldest.rawValue),
				URLQueryItem(name: "newest", value: newest.rawValue),
			]
		)
		let rows = try JSONDecoder().decode([IntervalsWellnessJSON].self, from: data)
		return rows.map(WellnessDay.init(json:))
	}

	public func fetchActivities(oldest: CivilDate, newest: CivilDate) async throws -> [ActivitySummary] {
		try IntervalsPolicy.rejectListRange(oldest: oldest, newest: newest)
		let json = try await getJSON(
			path: ["athlete", athletePath, "activities"],
			query: [
				URLQueryItem(name: "oldest", value: oldest.rawValue),
				URLQueryItem(name: "newest", value: newest.rawValue),
			]
		)
		return (json.arrayValue ?? []).compactMap(Self.activitySummary(from:))
	}

	public func fetchActivity(id: ActivityID) async throws -> JSONValue {
		try await getJSON(path: ["activity", id.rawValue])
	}

	public func fetchStreams(id: ActivityID) async throws -> JSONValue {
		let json = try await getJSON(
			path: ["activity", id.rawValue, "streams.json"],
			query: [
				URLQueryItem(name: "types", value: IntervalsPolicy.defaultStreamTypes.joined(separator: ",")),
			]
		)
		return IntervalsStreamSummary.summarize(json)
	}

	public func listEvents(oldest: CivilDate, newest: CivilDate) async throws -> [CalendarEvent] {
		try IntervalsPolicy.rejectListRange(oldest: oldest, newest: newest)
		var query = [
			URLQueryItem(name: "oldest", value: oldest.rawValue),
			URLQueryItem(name: "newest", value: newest.rawValue),
		]
		query.append(contentsOf: IntervalsPolicy.eventCategories.map {
			URLQueryItem(name: "category", value: $0)
		})
		let json = try await getJSON(path: ["athlete", athletePath, "events"], query: query)
		return (json.arrayValue ?? []).compactMap(Self.calendarEvent(from:))
	}

	public func createChatEvent(_ draft: ChatCalendarCreate) async throws -> CalendarEvent {
		let json = try await sendJSON(
			method: "POST",
			path: ["athlete", athletePath, "events"],
			query: [URLQueryItem(name: "upsertOnUid", value: "false")],
			body: IntervalsPolicy.chatCreateBody(draft)
		)
		guard let event = Self.calendarEvent(from: json) else {
			throw IntervalsError(code: "invalid_json", details: "create event response was not an event")
		}
		return event
	}

	public func createOrUpdatePlanEvent(_ draft: PlanMirrorCreate) async throws -> CalendarEvent {
		_ = draft
		throw IntervalsError(code: "not_implemented", details: "Plan mirror writes are not available.")
	}

	public func updateEvent(id: EventID, name: String?, description: String?, date: CivilDate?) async throws -> CalendarEvent {
		let existing = try await fetchEvent(id: id)
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		try IntervalsPolicy.refuseMutableEvent(
			existing,
			today: today,
			eventId: id,
			action: "update",
			nextDate: date
		)
		var fields: [String: JSONValue] = [:]
		if let name {
			fields["name"] = .string(name)
		}
		if let description {
			fields["description"] = .string(description)
		}
		if let date {
			fields["start_date_local"] = .string("\(date.rawValue)T00:00:00")
		}
		let json = try await sendJSON(
			method: "PUT",
			path: ["athlete", athletePath, "events", String(id.rawValue)],
			body: .object(fields)
		)
		guard let event = Self.calendarEvent(from: json) else {
			throw IntervalsError(code: "invalid_json", details: "update event response was not an event")
		}
		return event
	}

	public func deleteEvent(id: EventID) async throws {
		let existing = try await fetchEvent(id: id)
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		try IntervalsPolicy.refuseMutableEvent(
			existing,
			today: today,
			eventId: id,
			action: "delete",
			nextDate: nil
		)
		_ = try await send(
			method: "DELETE",
			path: ["athlete", athletePath, "events", String(id.rawValue)]
		)
	}

	private var authorization: String {
		switch credential {
		case .apiKey(let key):
			let encoded = Data("API_KEY:\(key)".utf8).base64EncodedString()
			return "Basic \(encoded)"
		case .oauth(let access, _):
			return "Bearer \(access)"
		}
	}

	private func fetchEvent(id: EventID) async throws -> CalendarEvent {
		let json = try await getJSON(path: ["athlete", athletePath, "events", String(id.rawValue)])
		guard let event = Self.calendarEvent(from: json) else {
			throw IntervalsError(code: "invalid_json", details: "event \(id.rawValue) was not an event")
		}
		return event
	}

	private func getJSON(path: [String], query: [URLQueryItem] = []) async throws -> JSONValue {
		try parseJSON(try await send(method: "GET", path: path, query: query))
	}

	private func sendJSON(
		method: String,
		path: [String],
		query: [URLQueryItem] = [],
		body: JSONValue
	) async throws -> JSONValue {
		try parseJSON(try await send(method: method, path: path, query: query, body: body))
	}

	private func get(path: [String], query: [URLQueryItem] = []) async throws -> Data {
		try await send(method: "GET", path: path, query: query)
	}

	private func send(
		method: String,
		path: [String],
		query: [URLQueryItem] = [],
		body: JSONValue? = nil
	) async throws -> Data {
		var url = IntervalsPolicy.baseURL
		for component in path {
			url.append(path: component)
		}
		var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
		if !query.isEmpty {
			components.queryItems = query
		}
		guard let finalURL = components.url else {
			throw IntervalsError(code: "invalid_url", details: path.joined(separator: "/"))
		}
		var request = URLRequest(url: finalURL)
		request.httpMethod = method
		request.setValue(authorization, forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.timeoutInterval = IntervalsPolicy.requestTimeout
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = Data(body.canonicalDigestInput().utf8)
		}
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else {
			throw IntervalsError(code: "network", details: "missing http response")
		}
		guard (200..<300).contains(http.statusCode) else {
			throw IntervalsError(code: "http", details: "status \(http.statusCode)", status: http.statusCode)
		}
		return data
	}

	private func parseJSON(_ data: Data) throws -> JSONValue {
		guard let text = String(data: data, encoding: .utf8) else {
			throw IntervalsError(code: "invalid_json", details: "response was not UTF-8")
		}
		do {
			return try JSONValue.parse(text)
		} catch {
			throw IntervalsError(code: "invalid_json", details: "response was not JSON")
		}
	}

	private static func activitySummary(from json: JSONValue) -> ActivitySummary? {
		let fields = json.objectFields
		guard let name = fields["name"]?.stringValue else { return nil }
		let local = fields["start_date_local"]?.stringValue ?? fields["startDateLocal"]?.stringValue
		guard let local, let date = CivilDate(rawValue: String(local.prefix(10))) else { return nil }
		let duration = fields["moving_time"]?.intValue() ?? fields["movingTime"]?.intValue() ?? 0
		let load = fields["icu_training_load"]?.intValue() ?? fields["icuTrainingLoad"]?.intValue()
		return ActivitySummary(name: name, date: date, durationS: duration, trainingLoad: load)
	}

	private static func calendarEvent(from json: JSONValue) -> CalendarEvent? {
		let fields = json.objectFields
		guard let id = fields["id"]?.intValue() else { return nil }
		let start = fields["start_date_local"]?.stringValue ?? fields["startDateLocal"]?.stringValue ?? ""
		let name = fields["name"]?.stringValue ?? ""
		let category = fields["category"]?.stringValue ?? ""
		let externalId = fields["external_id"]?.stringValue ?? fields["externalId"]?.stringValue
		let uid = fields["uid"]?.stringValue
		let tags = (fields["tags"]?.arrayValue ?? []).compactMap(\.stringValue)
		return CalendarEvent(
			id: EventID(rawValue: id),
			startDateLocal: start,
			name: name,
			category: category,
			externalId: externalId,
			uid: uid,
			tags: tags,
			coachCreated: IntervalsPolicy.isCoachOwned(externalId: externalId, tags: tags)
		)
	}
}

package enum IntervalsStreamSummary {
	package static func summarize(_ raw: JSONValue) -> JSONValue {
		var channels: [String: JSONValue] = [:]
		var sampleCount = 0
		for (name, values) in channelArrays(raw) {
			guard let summary = summarizeChannel(values) else { continue }
			channels[name] = summary
			if values.count > sampleCount {
				sampleCount = values.count
			}
		}
		return .object([
			"sampleCount": .number(Double(sampleCount)),
			"channels": .object(channels),
		])
	}

	private static func channelArrays(_ raw: JSONValue) -> [(String, [JSONValue])] {
		if let items = raw.arrayValue {
			var out: [(String, [JSONValue])] = []
			for element in items {
				let fields = element.objectFields
				guard let type = fields["type"]?.stringValue, let data = fields["data"]?.arrayValue else {
					continue
				}
				out.append((type, data))
			}
			return out
		}
		if case .object(let object) = raw {
			return object.compactMap { key, value in
				guard let data = value.arrayValue else { return nil }
				return (key, data)
			}
		}
		return []
	}

	private static func summarizeChannel(_ values: [JSONValue]) -> JSONValue? {
		var min = Double.infinity
		var max = -Double.infinity
		var sum = 0.0
		var count = 0
		for value in values {
			guard let number = value.numberValue, number.isFinite else { continue }
			if number < min { min = number }
			if number > max { max = number }
			sum += number
			count += 1
		}
		guard count > 0 else { return nil }
		let mean = (sum / Double(count) * 10).rounded() / 10
		return .object([
			"min": .number(min),
			"max": .number(max),
			"mean": .number(mean),
		])
	}
}

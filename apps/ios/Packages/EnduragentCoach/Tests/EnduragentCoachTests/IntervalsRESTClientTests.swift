import Foundation
import Testing
@testable import EnduragentCoach

@Suite(.serialized)
struct IntervalsRESTClientTests {
	@Test func basicAuthHeaderBytes() async throws {
		let client = try makeClient(credential: .apiKey("test-key"))
		_ = try await client.fetchAthlete()
		let expected = "Basic " + Data("API_KEY:test-key".utf8).base64EncodedString()
		#expect(IntervalsURLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization") == expected)
		#expect(IntervalsURLProtocolStub.lastRequest?.timeoutInterval == IntervalsPolicy.requestTimeout)
	}

	@Test func oauthSendsBearer() async throws {
		let client = try makeClient(credential: .oauth(access: "access-token", refresh: "refresh-token"))
		_ = try await client.fetchAthlete()
		#expect(
			IntervalsURLProtocolStub.lastRequest?.value(forHTTPHeaderField: "Authorization")
				== "Bearer access-token"
		)
	}

	@Test func fetchAthleteReadsAda() async throws {
		let client = try makeClient()
		let athlete = try await client.fetchAthlete()
		#expect(athlete.id == "0")
		#expect(athlete.name == "Ada Kovač")
		#expect(athlete.ftp == 250)
	}

	@Test func wellnessDecodeMapsCtlAtlAndHidesThemOnWellnessDay() async throws {
		let client = try makeClient()
		let days = try await client.fetchWellness(oldest: "1998-06-12", newest: "1998-06-13")
		#expect(days.count == 2)
		let today = days.first { $0.date == "1998-06-13" }!
		#expect(today.fitness == 55.2)
		#expect(today.fatigue == 42.1)
		#expect(today.form == 55.2 - 42.1)
		let labels = Mirror(reflecting: today).children.compactMap(\.label)
		#expect(!labels.contains("ctl"))
		#expect(!labels.contains("atl"))
		let wire = try JSONDecoder().decode(
			[IntervalsWellnessJSON].self,
			from: try fixtureData("intervals-wellness")
		)
		#expect(wire[0].ctl == 55.2)
		#expect(wire[0].atl == 42.1)
		#expect(wire[0].rampRate == 1.4)
	}

	@Test func fetchActivitiesProjectsAdaRides() async throws {
		let client = try makeClient()
		let rows = try await client.fetchActivities(oldest: "1998-06-01", newest: "1998-06-13")
		#expect(rows.map(\.name) == ["Sunday long ride", "Tuesday tempo"])
		#expect(rows[0].date == "1998-06-07")
		#expect(rows[0].durationS == 7200)
		#expect(rows[0].trainingLoad == 120)
	}

	@Test func listEventsSendsCategoryQuery() async throws {
		let client = try makeClient()
		let events = try await client.listEvents(oldest: "1998-06-14", newest: "1998-06-20")
		let items = URLComponents(
			url: try #require(IntervalsURLProtocolStub.lastRequest?.url),
			resolvingAgainstBaseURL: false
		)?.queryItems ?? []
		let categories = items.filter { $0.name == "category" }.compactMap(\.value)
		#expect(Set(categories) == Set(IntervalsPolicy.eventCategories))
		#expect(events[0].coachCreated)
		#expect(events[0].name == "Endurance")
		#expect(!events[1].coachCreated)
	}

	@Test func fetchStreamsReturnsSummaryWithoutSeries() async throws {
		let client = try makeClient()
		let summary = try await client.fetchStreams(id: try #require(ActivityID(rawValue: "i1234567")))
		let expected = try JSONValue.parse(String(data: try fixtureData("streams-ts"), encoding: .utf8)!)
		#expect(summary.canonicalDigestInput() == expected.canonicalDigestInput())
		let encoded = canonicalJSON(summary)
		#expect(!encoded.contains("\"data\""))
		writeEvidence("streams-swift.json", canonicalJSON(summary))
	}

	@Test func rangeOf367DaysIsRejected() async throws {
		let client = try makeClient()
		let oldest: CivilDate = "1998-01-01"
		let newest = oldest.adding(days: 366)
		do {
			_ = try await client.fetchActivities(oldest: oldest, newest: newest)
			Issue.record("expected range_too_wide")
		} catch let error as IntervalsError {
			#expect(error.code == "range_too_wide")
		}
		do {
			_ = try await client.listEvents(oldest: oldest, newest: newest)
			Issue.record("expected range_too_wide")
		} catch let error as IntervalsError {
			#expect(error.code == "range_too_wide")
		}
		#expect(IntervalsURLProtocolStub.lastRequest == nil)
	}

	@Test func inclusive366DaysIsAllowed() async throws {
		let client = try makeClient()
		let oldest: CivilDate = "1998-01-01"
		let newest = oldest.adding(days: 365)
		_ = try await client.fetchActivities(oldest: oldest, newest: newest)
		#expect(IntervalsURLProtocolStub.lastRequest != nil)
	}

	@Test func createChatEventPostsSnakeCaseBodyWithoutForbiddenFields() async throws {
		let client = try makeClient(
			clock: FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")
		)
		let draft = try CyclingTools.parseCreateWorkout(
			try JSONValue.parse(
				#"{"date":"1998-06-14","workout":{"name":"Endurance","steps":[{"type":"warmup","duration":{"value":10,"unit":"minutes"},"power":{"kind":"percent_ftp","low":55,"high":65}}]}}"#
			),
			today: "1998-06-13"
		)
		let event = try await client.createChatEvent(draft)
		let request = try #require(IntervalsURLProtocolStub.lastRequest)
		#expect(request.httpMethod == "POST")
		#expect(request.url?.path.hasSuffix("/athlete/0/events") == true)
		#expect(request.url?.query == "upsertOnUid=false")
		let body = String(data: try #require(IntervalsURLProtocolStub.lastBody), encoding: .utf8)!
		#expect(body.contains("\"start_date_local\""))
		#expect(body.contains("\"external_id\""))
		#expect(!body.contains("moving_time"))
		#expect(!body.contains("icu_training_load"))
		#expect(!body.contains("\"uid\""))
		#expect(!body.contains("workout_doc"))
		#expect(event.name == "Endurance")
	}

	@Test func deleteRefusesRaceCategory() async throws {
		let client = try makeClient(
			clock: FixedClock(now: "1998-06-13T08:00:00+02:00", timeZone: "Europe/Amsterdam")
		)
		do {
			try await client.deleteEvent(id: EventID(rawValue: 43))
			Issue.record("expected not_a_workout")
		} catch let error as IntervalsError {
			#expect(error.code == "not_a_workout")
		}
	}

	private func makeClient(
		credential: IntervalsCredential = .apiKey("test-key"),
		clock: any Clock = SystemClock()
	) throws -> IntervalsRESTClient {
		IntervalsURLProtocolStub.reset()
		IntervalsURLProtocolStub.handler = { request in
			let path = request.url?.path ?? ""
			let method = request.httpMethod ?? "GET"
			if path.hasSuffix("/streams.json") {
				return (200, try fixtureData("intervals-streams"))
			}
			if path.contains("/wellness") {
				return (200, try fixtureData("intervals-wellness"))
			}
			if path.contains("/activities") {
				return (200, try fixtureData("intervals-activities"))
			}
			if path.contains("/events/") {
				if path.hasSuffix("/43") {
					let race = """
					{"id":43,"start_date_local":"1998-06-20T00:00:00","name":"Local race","category":"RACE_A","tags":[]}
					"""
					return (200, Data(race.utf8))
				}
				let owned = """
				{"id":42,"start_date_local":"1998-06-14T00:00:00","name":"Endurance","category":"WORKOUT","external_id":"cycling-coach:1998-06-14:endurance","tags":["cycling-coach"]}
				"""
				return (200, Data(owned.utf8))
			}
			if path.contains("/events") {
				if method == "POST" {
					let created = """
					{"id":1,"start_date_local":"1998-06-14T00:00:00","name":"Endurance","category":"WORKOUT","external_id":"cycling-coach:1998-06-14:endurance","tags":["cycling-coach"]}
					"""
					return (200, Data(created.utf8))
				}
				return (200, try fixtureData("intervals-events"))
			}
			if path.contains("/activity/") {
				return (200, try fixtureData("intervals-activity"))
			}
			return (200, try fixtureData("intervals-athlete"))
		}
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [IntervalsURLProtocolStub.self]
		configuration.timeoutIntervalForRequest = IntervalsPolicy.requestTimeout
		let session = URLSession(configuration: configuration)
		return IntervalsRESTClient(credential: credential, session: session, clock: clock)
	}
}

final class IntervalsURLProtocolStub: URLProtocol, @unchecked Sendable {
	nonisolated(unsafe) static var lastRequest: URLRequest?
	nonisolated(unsafe) static var lastBody: Data?
	nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
	private static let lock = NSLock()

	static func reset() {
		lock.lock()
		lastRequest = nil
		lastBody = nil
		handler = nil
		lock.unlock()
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		Self.lock.lock()
		Self.lastRequest = request
		Self.lastBody = Self.copyBody(request)
		let handler = Self.handler
		Self.lock.unlock()
		do {
			let (status, body) = try handler?(request) ?? (500, Data())
			let response = HTTPURLResponse(
				url: request.url!,
				statusCode: status,
				httpVersion: "HTTP/1.1",
				headerFields: ["Content-Type": "application/json"]
			)!
			client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
			client?.urlProtocol(self, didLoad: body)
			client?.urlProtocolDidFinishLoading(self)
		} catch {
			client?.urlProtocol(self, didFailWithError: error)
		}
	}

	override func stopLoading() {}

	private static func copyBody(_ request: URLRequest) -> Data? {
		if let body = request.httpBody {
			return body
		}
		guard let stream = request.httpBodyStream else {
			return nil
		}
		stream.open()
		defer { stream.close() }
		var data = Data()
		let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
		defer { buffer.deallocate() }
		while stream.hasBytesAvailable {
			let count = stream.read(buffer, maxLength: 4096)
			if count > 0 {
				data.append(buffer, count: count)
			} else {
				break
			}
		}
		return data
	}
}

func fixtureData(_ name: String) throws -> Data {
	guard
		let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
	else {
		throw URLError(.fileDoesNotExist)
	}
	return try Data(contentsOf: url)
}

func writeEvidence(_ name: String, _ text: String) {
	let directory = URL(
		fileURLWithPath: "/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/ios-app/evidence/005"
	)
	guard FileManager.default.fileExists(atPath: directory.path) else { return }
	try? text.write(to: directory.appendingPathComponent(name), atomically: true, encoding: .utf8)
}

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

	private func makeClient(
		credential: IntervalsCredential = .apiKey("test-key")
	) throws -> IntervalsRESTClient {
		IntervalsURLProtocolStub.reset()
		IntervalsURLProtocolStub.handler = { request in
			let path = request.url?.path ?? ""
			let name: String
			if path.hasSuffix("/streams.json") {
				name = "intervals-streams"
			} else if path.contains("/wellness") {
				name = "intervals-wellness"
			} else if path.contains("/activities") {
				name = "intervals-activities"
			} else if path.contains("/events") {
				name = "intervals-events"
			} else if path.contains("/activity/") {
				name = "intervals-activity"
			} else {
				name = "intervals-athlete"
			}
			return (200, try fixtureData(name))
		}
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [IntervalsURLProtocolStub.self]
		configuration.timeoutIntervalForRequest = IntervalsPolicy.requestTimeout
		let session = URLSession(configuration: configuration)
		return IntervalsRESTClient(credential: credential, session: session)
	}
}

final class IntervalsURLProtocolStub: URLProtocol, @unchecked Sendable {
	nonisolated(unsafe) static var lastRequest: URLRequest?
	nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
	private static let lock = NSLock()

	static func reset() {
		lock.lock()
		lastRequest = nil
		handler = nil
		lock.unlock()
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		Self.lock.lock()
		Self.lastRequest = request
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

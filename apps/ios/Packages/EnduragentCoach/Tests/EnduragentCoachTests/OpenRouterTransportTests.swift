import Foundation
import Synchronization
import Testing
@testable import EnduragentCoach

@Suite struct OpenRouterTransportTests {
	@Test func bodyOmitsTemperatureAndIncludesUsage() throws {
		let body = OpenRouterHTTP.body(for: sampleRequest(tools: true))
		let object = try objectValue(body)
		#expect(object["temperature"] == nil)
		#expect(object["model"] == .string("deepseek/deepseek-v4-flash"))
		#expect(object["stream"] == .bool(true))
		#expect(object["usage"] == .object(["include": .bool(true)]))
		#expect(object["tool_choice"] == .string("auto"))
		let tools = try arrayValue(object["tools"])
		#expect(tools.count == 1)
		let tool = try objectValue(tools[0])
		#expect(tool["type"] == .string("function"))
		let function = try objectValue(tool["function"])
		#expect(function["name"] == .string("intervals_fetch_athlete"))
		#expect(function["description"] == .string("Fetch the athlete profile."))
		#expect(function["parameters"] == .object(["type": .string("object")]))
		let messages = try arrayValue(object["messages"])
		#expect(messages.count == 4)
		let assistant = try objectValue(messages[2])
		#expect(assistant["role"] == .string("assistant"))
		let toolCalls = try arrayValue(assistant["tool_calls"])
		let call = try objectValue(toolCalls[0])
		#expect(call["id"] == .string("call_ada_1"))
		#expect(call["type"] == .string("function"))
		let callFunction = try objectValue(call["function"])
		#expect(callFunction["name"] == .string("intervals_fetch_athlete"))
		#expect(callFunction["arguments"] == .string("{}"))
		let toolMessage = try objectValue(messages[3])
		#expect(toolMessage["role"] == .string("tool"))
		#expect(toolMessage["tool_call_id"] == .string("call_ada_1"))
		#expect(toolMessage["content"] == .string("{\"name\":\"Ada Kovač\"}"))
	}

	@Test func bodyOmitsToolsWhenEmpty() throws {
		let body = OpenRouterHTTP.body(for: sampleRequest(tools: false))
		let object = try objectValue(body)
		#expect(object["tools"] == nil)
		#expect(object["tool_choice"] == nil)
		#expect(object["temperature"] == nil)
	}

	@Test func parserConcatenatesFragmentedToolCallArguments() async throws {
		let events = try await parseFixture("openrouter-tool-call-fragments")
		let calls = toolCalls(in: events)
		#expect(calls.count == 1)
		#expect(calls[0].id == "call_ada_week")
		#expect(calls[0].name == .intervalsFetchActivities)
		#expect(calls[0].arguments == "{\"days\":7}")
		guard case .finished(let reason, let usage) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(reason == .toolCalls)
		#expect(usage.inputTokens == 18)
		#expect(usage.outputTokens == 12)
		#expect(usage.cost == 0.5)
	}

	@Test func parserYieldsParallelToolCallsByIndex() async throws {
		let events = try await parseFixture("openrouter-parallel-tool-calls")
		let calls = toolCalls(in: events)
		#expect(calls.count == 2)
		#expect(calls[0].id == "call_ada_athlete")
		#expect(calls[0].name == .intervalsFetchAthlete)
		#expect(calls[0].arguments == "{}")
		#expect(calls[1].id == "call_ada_wellness")
		#expect(calls[1].name == .intervalsFetchWellness)
		#expect(calls[1].arguments == "{\"oldest\":\"1998-06-01\",\"newest\":\"1998-06-13\"}")
	}

	@Test func parserYieldsTextUsageAndNoTemperatureLeak() async throws {
		let events = try await parseFixture("openrouter-text-usage")
		#expect(textDeltas(in: events) == ["Your week ", "looked strong, Ada."])
		guard case .finished(let reason, let usage) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(reason == .stop)
		#expect(usage.inputTokens == 24)
		#expect(usage.outputTokens == 8)
		#expect(usage.cost == 0.25)
	}

	@Test func parserTreatsReasoningAndKeepAlivesAsHeartbeats() async throws {
		let events = try await parseFixture("openrouter-reasoning-keepalive")
		#expect(events.filter { $0 == .heartbeat }.count >= 3)
		#expect(textDeltas(in: events) == ["Rest on Sunday."])
		guard case .finished(let reason, _) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(reason == .stop)
	}

	@Test func parserMapsLengthFinishReason() async throws {
		let events = try await parseFixture("openrouter-finish-length")
		guard case .finished(let reason, let usage) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(reason == .length)
		#expect(usage.inputTokens == 40)
		#expect(usage.outputTokens == 20)
	}

	@Test func parserThrowsOnUnknownFinishReason() async {
		await #expect(throws: UnknownFinishReasonError.self) {
			_ = try await parseFixture("openrouter-finish-unknown")
		}
	}

	@Test func parserSumsUsageAndCostAcrossSteps() async throws {
		let events = try await parseFixture("openrouter-usage-sum")
		guard case .finished(_, let usage) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(usage.inputTokens == 20)
		#expect(usage.outputTokens == 3)
		#expect(usage.cost == 0.75)
	}

	@Test func parserOmitsCostWhenAnyStepLacksIt() async throws {
		let events = try await parseFixture("openrouter-usage-partial-cost")
		guard case .finished(_, let usage) = events.last else {
			Issue.record("expected finished")
			return
		}
		#expect(usage.inputTokens == 8)
		#expect(usage.outputTokens == 3)
		#expect(usage.cost == nil)
	}

	@Suite(.serialized)
	struct HTTP {
		@Test func streamPostsOnceWithBearerAndNoReferer() async throws {
			let sse = try fixture("openrouter-text-usage", ext: "sse")
			let state = HTTPCapture()
			let transport = stubbedTransport()
			let events = try await OpenRouterURLStub.withHandler({ request in
				state.record(request)
				return .ok(sse)
			}) {
				try await collect(transport.stream(sampleRequest(tools: false)))
			}
			#expect(state.posts == 1)
			let request = try #require(state.request)
			#expect(request.httpMethod == "POST")
			#expect(request.url?.absoluteString == "https://openrouter.test/api/v1/chat/completions")
			#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-key")
			#expect(request.value(forHTTPHeaderField: "HTTP-Referer") == nil)
			#expect(request.value(forHTTPHeaderField: "Referer") == nil)
			#expect(request.value(forHTTPHeaderField: "X-OpenRouter-Title") == nil)
			let bodyData = try #require(httpBody(from: request))
			let body = try JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
			#expect(body?["temperature"] == nil)
			#expect(body?["stream"] as? Bool == true)
			#expect(textDeltas(in: events) == ["Your week ", "looked strong, Ada."])
		}

		@Test func streamUsesDeadlineAsRequestTimeout() async throws {
			let sse = try fixture("openrouter-text-usage", ext: "sse")
			let state = TimeoutCapture()
			let transport = OpenRouterTransport(
				apiKey: "test-key",
				baseURL: URL(string: "https://openrouter.test/api/v1")!
			) { value in
				state.value = value
				let configuration = URLSessionConfiguration.ephemeral
				configuration.timeoutIntervalForRequest = value
				configuration.protocolClasses = [OpenRouterURLStub.self]
				return URLSession(configuration: configuration)
			}
			try await OpenRouterURLStub.withHandler({ _ in .ok(sse) }) {
				_ = try await collect(
					transport.stream(
						CompletionRequest.openRouter(
							messages: [
								WireMessage(role: .user, content: "Hi Ada", toolCalls: [], toolCallId: nil),
							],
							tools: [],
							deadline: .seconds(45)
						)
					)
				)
			}
			#expect(state.value == 45)
		}

		@Test func streamSurfaces401AsProviderAuthError() async throws {
			let body = try fixture("openrouter-unauthorized", ext: "json")
			let state = HTTPCapture()
			let transport = stubbedTransport()
			do {
				_ = try await OpenRouterURLStub.withHandler({ request in
					state.record(request)
					return OpenRouterURLStub.Response(
						statusCode: 401,
						headers: ["Content-Type": "application/json"],
						body: Data(body.utf8)
					)
				}) {
					try await collect(transport.stream(sampleRequest(tools: false)))
				}
				Issue.record("expected provider auth error")
			} catch let error as ProviderAuthError {
				#expect(error.statusCode == 401)
				#expect(error.body.contains("User not found."))
			}
			#expect(state.posts == 1)
		}
	}
}

private final class HTTPCapture: Sendable {
	private let state = Mutex<(request: URLRequest?, count: Int)>((nil, 0))

	var request: URLRequest? {
		state.withLock { $0.request }
	}

	var posts: Int {
		state.withLock { $0.count }
	}

	func record(_ request: URLRequest) {
		state.withLock { snapshot in
			snapshot.request = request
			snapshot.count += 1
		}
	}
}

private final class TimeoutCapture: Sendable {
	private let stored = Mutex<TimeInterval?>(nil)

	var value: TimeInterval? {
		get { stored.withLock { $0 } }
		set { stored.withLock { $0 = newValue } }
	}
}

private func sampleRequest(tools: Bool) -> CompletionRequest {
	CompletionRequest.openRouter(
		messages: [
			WireMessage(role: .system, content: "You are Ada Kovač's coach.", toolCalls: [], toolCallId: nil),
			WireMessage(role: .user, content: "How did 1998-06-13 look?", toolCalls: [], toolCallId: nil),
			WireMessage(
				role: .assistant,
				content: "",
				toolCalls: [
					WireToolCall(id: "call_ada_1", name: .intervalsFetchAthlete, arguments: "{}"),
				],
				toolCallId: nil
			),
			WireMessage(
				role: .tool,
				content: "{\"name\":\"Ada Kovač\"}",
				toolCalls: [],
				toolCallId: "call_ada_1"
			),
		],
		tools: tools
			? [
				ToolSchema(
					name: .intervalsFetchAthlete,
					description: "Fetch the athlete profile.",
					parameters: .object(["type": .string("object")])
				),
			]
			: [],
		deadline: .seconds(600)
	)
}

private func parseFixture(_ name: String) async throws -> [TransportEvent] {
	try await collect(OpenRouterSSEParser.events(from: fixture(name, ext: "sse")))
}

private func collect(_ stream: AsyncThrowingStream<TransportEvent, Error>) async throws -> [TransportEvent] {
	var events: [TransportEvent] = []
	for try await event in stream {
		events.append(event)
	}
	return events
}

private func fixture(_ name: String, ext: String) throws -> String {
	let url = try #require(
		Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures")
			?? Bundle.module.url(forResource: name, withExtension: ext)
	)
	return try String(contentsOf: url, encoding: .utf8)
}

private func objectValue(_ value: JSONValue?) throws -> [String: JSONValue] {
	guard case .object(let object) = value else {
		throw OpenRouterParseError.malformedSSE
	}
	return object
}

private func arrayValue(_ value: JSONValue?) throws -> [JSONValue] {
	guard case .array(let items) = value else {
		throw OpenRouterParseError.malformedSSE
	}
	return items
}

private func textDeltas(in events: [TransportEvent]) -> [String] {
	events.compactMap { event in
		if case .textDelta(let text) = event {
			return text
		}
		return nil
	}
}

private func toolCalls(in events: [TransportEvent]) -> [WireToolCall] {
	events.compactMap { event in
		if case .toolCall(let call) = event {
			return call
		}
		return nil
	}
}

private func httpBody(from request: URLRequest) -> Data? {
	if let body = request.httpBody {
		return body
	}
	guard let stream = request.httpBodyStream else {
		return nil
	}
	stream.open()
	defer { stream.close() }
	let bufferSize = 1024
	let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
	defer { buffer.deallocate() }
	var data = Data()
	while stream.hasBytesAvailable {
		let read = stream.read(buffer, maxLength: bufferSize)
		if read <= 0 {
			break
		}
		data.append(buffer, count: read)
	}
	return data
}

private func stubbedTransport() -> OpenRouterTransport {
	OpenRouterTransport(
		apiKey: "test-key",
		baseURL: URL(string: "https://openrouter.test/api/v1")!
	) { timeout in
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = timeout
		configuration.protocolClasses = [OpenRouterURLStub.self]
		return URLSession(configuration: configuration)
	}
}

private final class OpenRouterURLStub: URLProtocol, @unchecked Sendable {
	struct Response: Sendable {
		var statusCode: Int
		var headers: [String: String]
		var body: Data

		static func ok(_ sse: String) -> Response {
			Response(
				statusCode: 200,
				headers: ["Content-Type": "text/event-stream"],
				body: Data(sse.utf8)
			)
		}
	}

	private static let handler = Mutex<(@Sendable (URLRequest) -> Response)?>(nil)

	static func withHandler<T: Sendable>(
		_ handler: @escaping @Sendable (URLRequest) -> Response,
		perform: () async throws -> T
	) async throws -> T {
		let previous = Self.handler.withLock { current in
			let previous = current
			current = handler
			return previous
		}
		defer {
			Self.handler.withLock { $0 = previous }
		}
		return try await perform()
	}

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		let handler = Self.handler.withLock { $0 }
		guard let handler else {
			client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
			return
		}
		let response = handler(request)
		guard let url = request.url,
			let http = HTTPURLResponse(
				url: url,
				statusCode: response.statusCode,
				httpVersion: "HTTP/1.1",
				headerFields: response.headers
			)
		else {
			client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
			return
		}
		client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: response.body)
		client?.urlProtocolDidFinishLoading(self)
	}

	override func stopLoading() {}
}

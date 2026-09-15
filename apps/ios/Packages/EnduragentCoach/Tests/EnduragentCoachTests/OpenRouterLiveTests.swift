import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct OpenRouterLiveTests {
	@Test(.enabled(if: ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"] != nil))
	func streamsOneTurn() async throws {
		let apiKey = try #require(ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"])
		let request = CompletionRequest.openRouter(
			messages: [
				WireMessage(
					role: .user,
					content: "Reply with the single word pong.",
					toolCalls: [],
					toolCallId: nil
				),
			],
			tools: [
				ToolSchema(
					name: .intervalsFetchAthlete,
					description: "Fetch the athlete profile.",
					parameters: .object([
						"type": .string("object"),
						"properties": .object([:]),
					])
				),
			],
			deadline: .seconds(60)
		)
		let urlRequest = try OpenRouterHTTP.urlRequest(
			apiKey: apiKey,
			baseURL: URL(string: "https://openrouter.ai/api/v1")!,
			request: request
		)
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = OpenRouterHTTP.timeInterval(from: request.deadline)
		let session = URLSession(configuration: configuration)
		defer { session.finishTasksAndInvalidate() }
		let (bytes, response) = try await session.bytes(for: urlRequest)
		let http = try #require(response as? HTTPURLResponse)
		if http.statusCode == 401 {
			throw ProviderAuthError(
				statusCode: 401,
				body: try await OpenRouterHTTP.utf8String(from: bytes)
			)
		}
		#expect(http.statusCode == 200)
		var lines: [String] = []
		var sawCacheDiscount = false
		var sawCachedTokens = false
		var provider: String?
		for try await line in bytes.lines {
			lines.append(line)
			let flags = cacheFlags(in: line)
			sawCacheDiscount = sawCacheDiscount || flags.discount
			sawCachedTokens = sawCachedTokens || flags.cachedTokens
			if provider == nil {
				provider = providerField(in: line)
			}
		}
		var events: [TransportEvent] = []
		for try await event in OpenRouterSSEParser.events(from: lines.joined(separator: "\n")) {
			events.append(event)
		}
		#expect(!events.isEmpty)
		if case .finished(_, let usage) = events.last {
			#expect(usage.inputTokens > 0)
		} else {
			Issue.record("expected finished")
		}
		if let path = ProcessInfo.processInfo.environment["ENDURAGENT_LIVE_OUT"], !path.isEmpty {
			var payload: [String: Any] = [
				"events": events.map(json(event:)),
				"sawCacheDiscount": sawCacheDiscount,
				"sawCachedTokens": sawCachedTokens,
			]
			if let provider {
				payload["provider"] = provider
			}
			let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
			try data.write(to: URL(fileURLWithPath: path))
		}
	}
}

private func cacheFlags(in line: String) -> (discount: Bool, cachedTokens: Bool) {
	guard let object = jsonObject(fromSSELine: line) else {
		return (false, false)
	}
	return inspectCache(object)
}

private func providerField(in line: String) -> String? {
	guard let object = jsonObject(fromSSELine: line) else {
		return nil
	}
	return object["provider"] as? String
}

private func jsonObject(fromSSELine line: String) -> [String: Any]? {
	guard line.hasPrefix("data:") else {
		return nil
	}
	var payload = String(line.dropFirst(5))
	if payload.first == " " {
		payload.removeFirst()
	}
	guard payload != "[DONE]",
		let data = payload.data(using: .utf8),
		let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
	else {
		return nil
	}
	return object
}

private func inspectCache(_ value: Any) -> (discount: Bool, cachedTokens: Bool) {
	if let object = value as? [String: Any] {
		var discount = object["cache_discount"] != nil
		var cachedTokens = false
		if let details = object["prompt_tokens_details"] as? [String: Any],
			details["cached_tokens"] != nil
		{
			cachedTokens = true
		}
		for nested in object.values {
			let inner = inspectCache(nested)
			discount = discount || inner.discount
			cachedTokens = cachedTokens || inner.cachedTokens
		}
		return (discount, cachedTokens)
	}
	if let array = value as? [Any] {
		var discount = false
		var cachedTokens = false
		for nested in array {
			let inner = inspectCache(nested)
			discount = discount || inner.discount
			cachedTokens = cachedTokens || inner.cachedTokens
		}
		return (discount, cachedTokens)
	}
	return (false, false)
}

private func json(event: TransportEvent) -> [String: Any] {
	switch event {
	case .textDelta(let text):
		return ["type": "textDelta", "text": text]
	case .toolCall(let call):
		return [
			"type": "toolCall",
			"id": call.id,
			"name": call.name.rawValue,
			"arguments": call.arguments,
		]
	case .heartbeat:
		return ["type": "heartbeat"]
	case .finished(let reason, let usage):
		var payload: [String: Any] = [
			"type": "finished",
			"reason": reason.rawValue,
			"usage": [
				"inputTokens": usage.inputTokens,
				"outputTokens": usage.outputTokens,
			],
		]
		if let cost = usage.cost {
			var usageObject = payload["usage"] as? [String: Any] ?? [:]
			usageObject["cost"] = cost
			payload["usage"] = usageObject
		}
		return payload
	}
}

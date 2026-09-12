import Foundation

package actor ChatMailbox {
	package let chatId: ChatID
	private let runner: TurnRunner
	private let memory: Memory
	private let store: any RecordLog
	private let clock: any Clock
	private let transport: any ModelTransport
	private var tail: Task<Void, Never>
	private var current: Task<Void, Never>?
	private var flushTask: Task<Void, Never>?
	package private(set) var busy = false

	package init(
		chatId: ChatID,
		runner: TurnRunner,
		memory: Memory,
		store: any RecordLog,
		clock: any Clock,
		transport: any ModelTransport
	) {
		self.chatId = chatId
		self.runner = runner
		self.memory = memory
		self.store = store
		self.clock = clock
		self.transport = transport
		self.tail = Task {}
	}

	package func send(_ text: String, language: LanguagePreference) -> AsyncThrowingStream<CoachEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				await self.serializedTurn(text: text, language: language, continuation: continuation)
			}
			continuation.onTermination = { termination in
				guard case .cancelled = termination else { return }
				task.cancel()
				Task { await self.stop() }
			}
		}
	}

	private func serializedTurn(
		text: String,
		language: LanguagePreference,
		continuation: AsyncThrowingStream<CoachEvent, Error>.Continuation
	) async {
		await enqueue {
			await self.performTurn(text: text, language: language, continuation: continuation)
		}
	}

	private func performTurn(
		text: String,
		language: LanguagePreference,
		continuation: AsyncThrowingStream<CoachEvent, Error>.Continuation
	) async {
		busy = true
		defer { busy = false }
		do {
			try await runner.run(text: text, chatId: chatId, language: language) { event in
				continuation.yield(event)
			}
			continuation.finish()
		} catch is CancellationError {
			continuation.finish()
		} catch {
			continuation.finish(throwing: error)
		}
	}

	package func stop() {
		current?.cancel()
	}

	package func reset() async {
		await enqueue {
			let writerWait = RecordLogReset(store: self.store, clock: self.clock)
			try? await writerWait.run(chatId: self.chatId)
		}
	}

	package func runQueuedFlush() async {
		if let inFlight = flushTask {
			await inFlight.value
			return
		}
		let previous = tail
		let next = Task {
			await previous.value
			guard !Task.isCancelled else { return }
			try? await self.memory.flush(
				trigger: .softThreshold,
				chatId: self.chatId,
				transport: self.transport
			)
		}
		tail = next
		current = next
		flushTask = next
		await next.value
		if flushTask != nil {
			flushTask = nil
		}
	}

	private func enqueue(_ work: @escaping @Sendable () async -> Void) async {
		let previous = tail
		let next = Task {
			await previous.value
			guard !Task.isCancelled else { return }
			await work()
		}
		tail = next
		current = next
		await next.value
	}
}

private struct RecordLogReset {
	let store: any RecordLog
	let clock: any Clock

	func run(chatId: ChatID) async throws {
		let tz = IANATimeZone(identifier: clock.timeZone.identifier) ?? IANATimeZone(identifier: "GMT")!
		let marker = ULID.generate(at: clock.now)
		let record = AthleteRecord(
			ulid: marker,
			deviceId: store.deviceId,
			hlc: .tick(now: clock.now, deviceId: store.deviceId, last: nil),
			timeZone: tz,
			civilDate: IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone),
			body: .flushPending(FlushPendingBody(chatId: chatId, trigger: .explicitReset, messageUlids: []))
		)
		try await store.append(record)
		try await store.append(
			AthleteRecord(
				ulid: ULID.generate(at: clock.now),
				deviceId: store.deviceId,
				hlc: .tick(now: clock.now, deviceId: store.deviceId, last: record.hlc),
				timeZone: tz,
				civilDate: IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone),
				body: .windowStart(WindowStartBody(chatId: chatId, firstIncludedUlid: marker))
			)
		)
	}
}

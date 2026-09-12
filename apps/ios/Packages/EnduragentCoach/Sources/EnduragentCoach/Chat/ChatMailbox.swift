import Foundation

package actor ChatMailbox {
	package let chatId: ChatID
	private let runner: TurnRunner
	private let memory: Memory
	private let store: any RecordLog
	private let clock: any Clock

	package init(
		chatId: ChatID,
		runner: TurnRunner,
		memory: Memory,
		store: any RecordLog,
		clock: any Clock
	) {
		self.chatId = chatId
		self.runner = runner
		self.memory = memory
		self.store = store
		self.clock = clock
	}

	package func send(_ text: String, language: LanguagePreference) -> AsyncThrowingStream<CoachEvent, Error> {
		fatalError("not implemented")
	}

	package func stop() {
		fatalError("not implemented")
	}

	package func reset() async {
		fatalError("not implemented")
	}

	package func runQueuedFlush() async {
		fatalError("not implemented")
	}
}

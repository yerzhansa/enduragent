import Foundation

package enum WatchdogTimeout: Error, Sendable {
	case ttft
	case interChunk
}

package actor ChatWatchdog {
	package static let ttft: Duration = .seconds(30)
	package static let interChunk: Duration = .seconds(30)

	private var timer: Task<Void, Never>?
	private var toolIds: Set<String> = []
	private var seenText = false
	private var stopped = true
	private var outcome: WatchdogTimeout?
	private var waiters: [CheckedContinuation<WatchdogTimeout?, Never>] = []

	package init() {}

	package func arm() {
		stopped = false
		seenText = false
		outcome = nil
		schedule()
	}

	package func beat() {
		seenText = true
		schedule()
	}

	package func pauseForTools(_ ids: Set<String>) {
		toolIds = ids
		if ids.isEmpty {
			if !stopped {
				schedule()
			}
		} else {
			cancelTimer()
		}
	}

	package func disarm() {
		stopped = true
		cancelTimer()
		resumeWaiters(nil)
	}

	package func fired() async -> WatchdogTimeout? {
		await withTaskCancellationHandler {
			await self.waitForFire()
		} onCancel: {
			Task { await self.resumeWaiters(nil) }
		}
	}

	private func waitForFire() async -> WatchdogTimeout? {
		if let outcome {
			return outcome
		}
		if stopped || Task.isCancelled {
			return nil
		}
		return await withCheckedContinuation { continuation in
			if let outcome {
				continuation.resume(returning: outcome)
			} else if stopped || Task.isCancelled {
				continuation.resume(returning: nil)
			} else {
				waiters.append(continuation)
			}
		}
	}

	private func resumeWaiters(_ value: WatchdogTimeout?) {
		let pending = waiters
		waiters.removeAll()
		for waiter in pending {
			waiter.resume(returning: value)
		}
	}

	private func schedule() {
		cancelTimer()
		guard !stopped, toolIds.isEmpty else { return }
		let delay: Duration = seenText ? Self.interChunk : Self.ttft
		let kind: WatchdogTimeout = seenText ? .interChunk : .ttft
		timer = Task {
			do {
				try await Task.sleep(for: delay)
			} catch {
				return
			}
			guard !Task.isCancelled else { return }
			self.fire(kind)
		}
	}

	private func fire(_ kind: WatchdogTimeout) {
		guard !stopped, outcome == nil else { return }
		outcome = kind
		stopped = true
		cancelTimer()
		resumeWaiters(kind)
	}

	private func cancelTimer() {
		timer?.cancel()
		timer = nil
	}
}

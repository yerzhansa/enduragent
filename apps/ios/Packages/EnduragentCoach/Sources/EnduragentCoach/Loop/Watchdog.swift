import Foundation

package enum WatchdogTimeout: Error, Sendable {
	case ttft
	case interChunk
}

package actor ChatWatchdog {
	package static let ttft: Duration = .seconds(30)
	package static let interChunk: Duration = .seconds(30)

	package init() {}

	package func arm() {
		fatalError("not implemented")
	}

	package func beat() {
		fatalError("not implemented")
	}

	package func pauseForTools(_ ids: Set<String>) {
		fatalError("not implemented")
	}

	package func disarm() {
		fatalError("not implemented")
	}
}

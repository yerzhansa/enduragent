import Foundation

public protocol Clock: Sendable {
	var now: Date { get }
	var timeZone: TimeZone { get }
	var backgroundRemaining: Duration? { get }
}

public struct SystemClock: Clock {
	public init() {}

	public var now: Date { Date() }
	public var timeZone: TimeZone { .current }
	public var backgroundRemaining: Duration? { nil }
}

public final class FixedClock: Clock, @unchecked Sendable {
	public var now: Date
	public var timeZone: TimeZone
	public var backgroundRemaining: Duration?

	public init(now: String, timeZone: String) {
		let tz = TimeZone(identifier: timeZone) ?? .gmt
		self.timeZone = tz
		self.backgroundRemaining = nil
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withColonSeparatorInTimeZone]
		self.now = formatter.date(from: now) ?? Date(timeIntervalSince1970: 0)
	}

	public func advance(by interval: TimeInterval) {
		now = now.addingTimeInterval(interval)
	}
}

import Foundation

public struct HybridLogicalClock: Sendable, Hashable, Comparable {
	public var wallMs: Int64
	public var logical: UInt32
	public var deviceId: DeviceID

	public init(wallMs: Int64, logical: UInt32, deviceId: DeviceID) {
		self.wallMs = wallMs
		self.logical = logical
		self.deviceId = deviceId
	}

	public static func tick(now: Date, deviceId: DeviceID, last: HybridLogicalClock?) -> HybridLogicalClock {
		let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
		guard let last else {
			return HybridLogicalClock(wallMs: nowMs, logical: 0, deviceId: deviceId)
		}
		let wallMs = max(nowMs, last.wallMs)
		let logical: UInt32 = wallMs == last.wallMs ? last.logical + 1 : 0
		return HybridLogicalClock(wallMs: wallMs, logical: logical, deviceId: deviceId)
	}

	public static func < (lhs: HybridLogicalClock, rhs: HybridLogicalClock) -> Bool {
		if lhs.wallMs != rhs.wallMs { return lhs.wallMs < rhs.wallMs }
		if lhs.logical != rhs.logical { return lhs.logical < rhs.logical }
		return lhs.deviceId.rawValue < rhs.deviceId.rawValue
	}
}

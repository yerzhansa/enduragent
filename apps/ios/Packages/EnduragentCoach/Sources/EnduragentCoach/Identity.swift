import CryptoKit
import Foundation

public struct ULID: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init?(rawValue: String) {
		let alphabet = CharacterSet(charactersIn: "0123456789ABCDEFGHJKMNPQRSTVWXYZ")
		guard rawValue.count == 26, rawValue.unicodeScalars.allSatisfy({ alphabet.contains($0) }) else {
			return nil
		}
		self.rawValue = rawValue
	}

	public static func generate(at now: Date) -> ULID {
		let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
		let ms = max(0, (now.timeIntervalSince1970 * 1000).rounded(.down))
		var time = UInt64(ms)
		var chars = [Character](repeating: "0", count: 26)
		for index in (0..<10).reversed() {
			chars[index] = alphabet[Int(time % 32)]
			time /= 32
		}
		var rng = SystemRandomNumberGenerator()
		for index in 10..<26 {
			chars[index] = alphabet[Int(rng.next() % 32)]
		}
		return ULID(rawValue: String(chars))!
	}
}

public struct DeviceID: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init(rawValue: String) {
		self.rawValue = rawValue
	}

	public init() {
		self.rawValue = UUID().uuidString
	}
}

public struct ChatID: Hashable, Sendable, ExpressibleByStringLiteral {
	public let rawValue: String

	public init?(rawValue: String) {
		guard !rawValue.isEmpty, rawValue != "desktop", !rawValue.hasPrefix("plan:") else {
			return nil
		}
		self.rawValue = rawValue
	}

	public init(stringLiteral value: String) {
		guard let parsed = ChatID(rawValue: value) else {
			fatalError("invalid chat id")
		}
		self = parsed
	}

	public static let main: ChatID = "main"
}

public struct Nonce: Hashable, Sendable, RawRepresentable {
	public let rawValue: UUID

	public init(rawValue: UUID) {
		self.rawValue = rawValue
	}

	public init() {
		self.rawValue = UUID()
	}
}

public struct CivilDate: Hashable, Sendable, Comparable, ExpressibleByStringLiteral, CustomStringConvertible {
	public let rawValue: String

	public init?(rawValue: String) {
		guard Self.isRealDateKey(rawValue) else { return nil }
		self.rawValue = rawValue
	}

	public init(stringLiteral value: String) {
		guard let parsed = CivilDate(rawValue: value) else {
			fatalError("invalid civil date")
		}
		self = parsed
	}

	public var description: String { rawValue }

	public static func < (lhs: CivilDate, rhs: CivilDate) -> Bool {
		lhs.rawValue < rhs.rawValue
	}

	public static func isRealDateKey(_ value: String) -> Bool {
		let formatter = DateFormatter()
		formatter.calendar = Calendar(identifier: .gregorian)
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(secondsFromGMT: 0)
		formatter.dateFormat = "yyyy-MM-dd"
		formatter.isLenient = false
		return formatter.date(from: value) != nil
	}

	public func adding(days: Int) -> CivilDate {
		var calendar = Calendar(identifier: .gregorian)
		calendar.locale = Locale(identifier: "en_US_POSIX")
		calendar.timeZone = TimeZone(secondsFromGMT: 0)!
		let parts = rawValue.split(separator: "-")
		let components = DateComponents(
			year: Int(parts[0]),
			month: Int(parts[1]),
			day: Int(parts[2])
		)
		let date = calendar.date(from: components)!
		let shifted = calendar.date(byAdding: .day, value: days, to: date)!
		let out = calendar.dateComponents([.year, .month, .day], from: shifted)
		let formatted = String(format: "%04d-%02d-%02d", out.year!, out.month!, out.day!)
		return CivilDate(rawValue: formatted)!
	}
}

public struct DateKey: Hashable, Sendable, Comparable {
	public let rawValue: Int

	public init?(rawValue: Int) {
		guard rawValue >= 1000_01_01, rawValue <= 9999_12_31 else { return nil }
		self.rawValue = rawValue
	}

	public static func from(_ date: CivilDate) -> DateKey {
		DateKey(rawValue: Int(date.rawValue.replacingOccurrences(of: "-", with: ""))!)!
	}

	public var civil: CivilDate {
		let year = rawValue / 10_000
		let month = (rawValue / 100) % 100
		let day = rawValue % 100
		return CivilDate(rawValue: String(format: "%04d-%02d-%02d", year, month, day))!
	}

	public static func < (lhs: DateKey, rhs: DateKey) -> Bool {
		lhs.rawValue < rhs.rawValue
	}
}

public struct IANATimeZone: Hashable, Sendable {
	public let identifier: String

	public init?(identifier: String) {
		guard TimeZone(identifier: identifier) != nil else { return nil }
		self.identifier = identifier
	}

	public var timeZone: TimeZone {
		TimeZone(identifier: identifier) ?? .gmt
	}
}

public enum SportID: String, Sendable {
	case cycling
}

public enum JSONValue: Sendable, Equatable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public static func parse(_ raw: String) throws -> JSONValue {
		guard let data = raw.data(using: .utf8) else {
			throw DecodingError.dataCorrupted(
				.init(codingPath: [], debugDescription: "invalid JSON")
			)
		}
		let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
		return try JSONValue.fromJSONObject(object)
	}

	public func canonicalDigestInput() -> String {
		JSONValue.render(self, pretty: false, depth: 0)
	}

	private static func fromJSONObject(_ object: Any) throws -> JSONValue {
		switch object {
		case is NSNull:
			return .null
		case let number as NSNumber:
			if CFGetTypeID(number) == CFBooleanGetTypeID() {
				return .bool(number.boolValue)
			}
			return .number(number.doubleValue)
		case let string as String:
			return .string(string)
		case let array as [Any]:
			return .array(try array.map { try fromJSONObject($0) })
		case let dictionary as [String: Any]:
			var object: [String: JSONValue] = [:]
			object.reserveCapacity(dictionary.count)
			for (key, value) in dictionary {
				object[key] = try fromJSONObject(value)
			}
			return .object(object)
		default:
			throw DecodingError.dataCorrupted(
				.init(codingPath: [], debugDescription: "invalid JSON")
			)
		}
	}

	fileprivate static func render(_ value: JSONValue, pretty: Bool, depth: Int) -> String {
		switch value {
		case .null:
			return "null"
		case .bool(let flag):
			return flag ? "true" : "false"
		case .number(let number):
			return encodeJSONNumber(number)
		case .string(let string):
			return encodeJSONString(string)
		case .array(let items):
			if items.isEmpty { return "[]" }
			if !pretty {
				return "[" + items.map { render($0, pretty: false, depth: 0) }.joined(separator: ",") + "]"
			}
			let pad = String(repeating: "  ", count: depth + 1)
			let close = String(repeating: "  ", count: depth)
			let inner = items.map { pad + render($0, pretty: true, depth: depth + 1) }.joined(separator: ",\n")
			return "[\n\(inner)\n\(close)]"
		case .object(let fields):
			let keys = fields.keys.sorted()
			if keys.isEmpty { return "{}" }
			if !pretty {
				return "{"
					+ keys.map { encodeJSONString($0) + ":" + render(fields[$0]!, pretty: false, depth: 0) }
					.joined(separator: ",")
					+ "}"
			}
			let pad = String(repeating: "  ", count: depth + 1)
			let close = String(repeating: "  ", count: depth)
			let inner = keys.map {
				pad + encodeJSONString($0) + ": " + render(fields[$0]!, pretty: true, depth: depth + 1)
			}.joined(separator: ",\n")
			return "{\n\(inner)\n\(close)}"
		}
	}
}

public func canonicalJSON(_ value: JSONValue) -> String {
	JSONValue.render(value, pretty: true, depth: 0)
}

public func sha256Hex(_ utf8: String) -> String {
	SHA256.hash(data: Data(utf8.utf8)).map { byte in
		String(byte, radix: 16).leftPadHex
	}.joined()
}

public func estimateTokens(_ text: String) -> Int {
	Int((Double(text.utf16.count) / 4.0 * 1.2).rounded(.up))
}

private extension String {
	var leftPadHex: String { count == 1 ? "0" + self : self }
}

private func encodeJSONString(_ string: String) -> String {
	var out = "\""
	for scalar in string.unicodeScalars {
		switch scalar.value {
		case 0x22: out += "\\\""
		case 0x5C: out += "\\\\"
		case 0x08: out += "\\b"
		case 0x0C: out += "\\f"
		case 0x0A: out += "\\n"
		case 0x0D: out += "\\r"
		case 0x09: out += "\\t"
		case 0x00..<0x20:
			out += "\\u" + String(format: "%04x", scalar.value)
		case 0x2028:
			out += "\\u2028"
		case 0x2029:
			out += "\\u2029"
		default:
			out.append(Character(scalar))
		}
	}
	out += "\""
	return out
}

private func encodeJSONNumber(_ value: Double) -> String {
	if !value.isFinite {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	let maxSafe = 9_007_199_254_740_991.0
	if abs(value) <= maxSafe, value.rounded(.towardZero) == value {
		return String(Int64(value))
	}
	return String(value)
}

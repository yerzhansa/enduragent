import Foundation

public enum SlashCommand: String, Sendable, CaseIterable {
	case review = "/review"
	case status = "/status"
	case workout = "/workout"
	case plan = "/plan"
	case language = "/language"

	public static let all: [SlashCommand] = [.review, .status, .workout, .plan, .language]

	public var startsModelTurn: Bool {
		switch self {
		case .review, .status, .workout: return true
		case .plan, .language: return false
		}
	}
}

public enum SlashRouting {
	public static func parse(_ text: String) -> SlashCommand? {
		guard let token = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).first else {
			return nil
		}
		return SlashCommand(rawValue: String(token))
	}
}

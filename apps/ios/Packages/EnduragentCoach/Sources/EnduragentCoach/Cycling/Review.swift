import Foundation

public enum WorkoutReview {
	public static let sessionClusterGapMinutes = 30
	public static let windowDays = 7
	public static let emptyWindow = "No activity in the last 7 days — want me to look further back?"
	public static let numbersFooter = "Reply 'show numbers' for the full breakdown."
	public static let deeperFooter = "For a deeper analysis, type /review deep."

	public static func staleWindow(daysAgo: Int) -> String {
		"Your last session was \(daysAgo) days ago — want me to review that?"
	}
}

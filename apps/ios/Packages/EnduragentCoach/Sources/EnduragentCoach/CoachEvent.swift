import Foundation

public enum CoachEvent: Sendable, Equatable {
	case textDelta(String)
	case toolStarted(name: String, callId: String)
	case toolFinished(name: String, callId: String)
	case proposalPending(PendingProposal)
	case planCard(PlanCard)
	case languagePicker
	case finished
	case failed(message: String)
	case interrupted(text: String)
}

public struct ChatMessage: Sendable, Equatable {
	public var role: Role
	public var text: String
	public var civilDate: CivilDate?

	public init(role: Role, text: String, civilDate: CivilDate? = nil) {
		self.role = role
		self.text = text
		self.civilDate = civilDate
	}

	public enum Role: String, Sendable {
		case user
		case assistant
	}
}

public enum ConfirmOutcome: Sendable, Equatable {
	case executed(summary: String)
	case refused(message: String)
	case failed(message: String)
	case expired
	case mismatch
	case none
}

public struct LanguagePreference: Sendable, Equatable {
	public var ui: LanguageTag
	public var coachReply: LanguageTag?

	public init(ui: LanguageTag, coachReply: LanguageTag?) {
		self.ui = ui
		self.coachReply = coachReply
	}
}

public enum ToolName: String, Sendable {
	case calculateZones = "calculate_zones"
	case buildPlanSkeleton = "build_plan_skeleton"
	case assessFeasibility = "assess_feasibility"
	case getSampleWeek = "get_sample_week"
	case intervalsFetchAthlete = "intervals_fetch_athlete"
	case intervalsFetchWellness = "intervals_fetch_wellness"
	case intervalsFetchActivity = "intervals_fetch_activity"
	case intervalsFetchStreams = "intervals_fetch_streams"
	case intervalsFetchActivities = "intervals_fetch_activities"
	case intervalsListEvents = "intervals_list_events"
	case intervalsCreateWorkout = "intervals_create_workout"
	case intervalsCreateStrengthWorkout = "intervals_create_strength_workout"
	case intervalsDeleteWorkout = "intervals_delete_workout"
	case intervalsUpdateWorkout = "intervals_update_workout"
	case memoryRead = "memory_read"
	case memoryQuery = "memory_query"
	case memoryWrite = "memory_write"
	case ledgerAppend = "ledger_append"
	case planSave = "plan_save"
	case planLoad = "plan_load"
}

public enum GatedToolName: String, Sendable {
	case intervalsCreateWorkout = "intervals_create_workout"
	case intervalsCreateStrengthWorkout = "intervals_create_strength_workout"
	case intervalsDeleteWorkout = "intervals_delete_workout"
	case intervalsUpdateWorkout = "intervals_update_workout"
	case planSave = "plan_save"

	public var toolName: ToolName {
		ToolName(rawValue: rawValue)!
	}

	public static let all: Set<GatedToolName> = [
		.intervalsCreateWorkout,
		.intervalsCreateStrengthWorkout,
		.intervalsDeleteWorkout,
		.intervalsUpdateWorkout,
		.planSave,
	]
}

public enum ReplayUnsafeToolName: String, Sendable {
	case intervalsCreateWorkout = "intervals_create_workout"
	case intervalsCreateStrengthWorkout = "intervals_create_strength_workout"
	case intervalsDeleteWorkout = "intervals_delete_workout"
	case intervalsUpdateWorkout = "intervals_update_workout"
	case memoryWrite = "memory_write"
	case ledgerAppend = "ledger_append"
	case planSave = "plan_save"
}

import Foundation

package enum MemoryFlushPrompt {
	package static let system = """
		You are reviewing a conversation to extract and save important athlete
		information before it is summarized. Use the memory_write tool to save
		details into the appropriate section. Each section is fully replaced on
		write, so include ALL current facts for that section, not just new ones.
		Use the ledger_append tool to record dated events (decisions, overrides,
		illness, experiment outcomes); ledger entries are appended, never replaced.
		"""

	package static func userPrompt(sections: [SectionName], currentMemory: String, today: String) -> String {
		let sectionList = sections.map { "- \"\($0.rawValue)\": \($0.sectionDescription)" }.joined(separator: "\n")
		return """
			Review the new conversation messages above and save athlete details to
			structured memory sections. The current memory is shown below; write each
			section that has new or updated information.

			Write to these sections using memory_write:
			\(sectionList)

			For each section you write, include ALL current facts for that section
			(both from memory and from the conversation). This fully replaces the
			section content — omitted facts will be lost.

			Dating discipline for durable facts:
			- Append "(<source>, <YYYY-MM-DD>)" to each material fact — who stated it
			  (athlete, coach, intervals.icu) and the date it was last confirmed.
			  Example: "- FTP 252W (athlete, 1998-06-08)".
			- When carrying an unchanged fact forward, keep its existing source and date;
			  re-date a fact only when this conversation re-confirmed it.
			- If a fact's date is more than 6 months before today, keep the fact and
			  append "(re-confirm)" so it can be verified with the athlete.
			- Never write "_updated:" lines yourself; the system stamps each section's
			  update date automatically.

			Keep each section under ~\(MemoryFlushPolicy.memorySectionBudgetChars) characters. When a
			section would grow past that, do NOT let it balloon: move the dated or episodic
			detail (specific workouts, day-by-day observations, one-off events) out to the
			event ledger (ledger_append), and keep only the current durable facts in the
			section itself. Nothing is dropped — ledger entries stay reachable through
			memory_query.

			Today is \(today).

			Also record dated events in the permanent event ledger using ledger_append:
			- decisions made with the athlete, with the rationale
			- times the athlete overrode, declined, or changed a recommendation
			- illness, injury, or pain mentions (acute ones count — they need no memory section)
			- experiment outcomes (what was tried, what happened)
			Date each event (YYYY-MM-DD) with the day it happened, which may be earlier
			than today. Record only events from this conversation; never re-record
			events that earlier reviews already saved.

			Only write sections that have new or changed information.

			Current memory:

			\(currentMemory)
			"""
	}

	package static func toolSchemas() -> [ToolSchema] {
		let names = SectionName.cyclingEffective.map(\.rawValue)
		return [
			ToolSchema(
				name: .memoryWrite,
				description: "Write to a memory section (replaces entire section content)",
				parameters: .object([
					"type": .string("object"),
					"properties": .object([
						"section": .object([
							"type": .string("string"),
							"enum": .array(names.map { .string($0) }),
							"description": .string("Which section to write"),
						]),
						"content": .object([
							"type": .string("string"),
							"description": .string("Complete section content — include ALL facts for this section"),
						]),
					]),
					"required": .array([.string("section"), .string("content")]),
				])
			),
			ToolSchema(
				name: .ledgerAppend,
				description:
					"Record a dated athlete event (decision, override, illness, experiment, outcome) in the permanent event ledger. Entries are appended, never replaced.",
				parameters: .object([
					"type": .string("object"),
					"properties": .object([
						"date": .object([
							"type": .string("string"),
							"description": .string("Event date, YYYY-MM-DD, athlete-local"),
						]),
						"kind": .object([
							"type": .string("string"),
							"enum": .array(LedgerKind.allCases.map { .string($0.rawValue) }),
							"description": .string("Event category"),
						]),
						"text": .object([
							"type": .string("string"),
							"description": .string("One or two sentences, with rationale or outcome when stated"),
						]),
					]),
					"required": .array([.string("date"), .string("kind"), .string("text")]),
				])
			),
		]
	}
}

extension LedgerKind: CaseIterable {
	public static var allCases: [LedgerKind] {
		[.decision, .override, .illness, .experiment, .outcome]
	}
}

import Foundation

package enum UnionMerge {
	package static func conversation(
		_ records: [AthleteRecord],
		chatId: ChatID,
		deviceId: DeviceID
	) -> [ChatMessage] {
		fatalError("not implemented")
	}

	package static func sectionText(_ records: [AthleteRecord], name: SectionName) -> String? {
		fatalError("not implemented")
	}

	package static func ledger(_ records: [AthleteRecord]) -> [LedgerEventBody] {
		fatalError("not implemented")
	}

	package static func ledgerDigest(date: CivilDate, kind: LedgerKind, text: String) -> String {
		fatalError("not implemented")
	}

	package static func planningDevice(_ records: [AthleteRecord]) -> PlanningDeviceBody? {
		fatalError("not implemented")
	}

	package static func coachReplyLanguage(_ records: [AthleteRecord]) -> LanguageTag? {
		fatalError("not implemented")
	}

	package static func pendingProposal(
		_ records: [AthleteRecord],
		chatId: ChatID,
		now: Date
	) -> ProposalBody? {
		fatalError("not implemented")
	}
}

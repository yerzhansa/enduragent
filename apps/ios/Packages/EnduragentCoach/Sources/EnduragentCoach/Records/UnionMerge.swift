import Foundation

package enum UnionMerge {
	package static func conversation(
		_ records: [AthleteRecord],
		chatId: ChatID,
		deviceId: DeviceID
	) -> [ChatMessage] {
		let ordered = inHLCOrder(records)
		let cutoff = ordered.last { record in
			guard record.deviceId == deviceId else { return false }
			guard case .windowStart(let body) = record.body else { return false }
			return body.chatId == chatId
		}
		let firstIncluded: ULID?
		if case .windowStart(let body)? = cutoff?.body {
			firstIncluded = body.firstIncludedUlid
		} else {
			firstIncluded = nil
		}
		return ordered.compactMap { record in
			if let firstIncluded, record.ulid.rawValue < firstIncluded.rawValue {
				return nil
			}
			switch record.body {
			case .userMessage(let body) where body.chatId == chatId:
				return ChatMessage(role: .user, text: body.athleteText, civilDate: record.civilDate)
			case .assistantMessage(let body) where body.chatId == chatId:
				return ChatMessage(role: .assistant, text: body.text, civilDate: record.civilDate)
			default:
				return nil
			}
		}
	}

	package static func sectionText(_ records: [AthleteRecord], name: SectionName) -> String? {
		inHLCOrder(records).reversed().compactMap { record -> String? in
			guard case .memorySection(let body) = record.body, body.name == name else { return nil }
			return body.content
		}.first
	}

	package static func ledger(_ records: [AthleteRecord]) -> [LedgerEventBody] {
		var seen: Set<String> = []
		var events: [LedgerEventBody] = []
		for record in inHLCOrder(records) {
			guard case .ledgerEvent(let body) = record.body else { continue }
			let digest = ledgerDigest(date: record.civilDate, kind: body.kind, text: body.text)
			if seen.insert(digest).inserted {
				events.append(body)
			}
		}
		return events
	}

	package static func ledgerDigest(date: CivilDate, kind: LedgerKind, text: String) -> String {
		let normalized = text.replacing(/^[\s]+|[\s]+$/, with: "").replacing(/\s+/, with: " ").lowercased()
		let input = JSONValue.array([.string(date.rawValue), .string(kind.rawValue), .string(normalized)]).canonicalDigestInput()
		return sha256Hex(input)
	}

	package static func planningDevice(_ records: [AthleteRecord]) -> PlanningDeviceBody? {
		inHLCOrder(records).reversed().compactMap { record -> PlanningDeviceBody? in
			guard case .planningDevice(let body) = record.body else { return nil }
			return body
		}.first
	}

	package static func coachReplyLanguage(_ records: [AthleteRecord]) -> LanguageTag? {
		for record in inHLCOrder(records).reversed() {
			if case .coachReplyLanguage(let body) = record.body {
				return body.tag
			}
		}
		return nil
	}

	package static func pendingProposal(
		_ records: [AthleteRecord],
		chatId: ChatID,
		now: Date
	) -> ProposalBody? {
		let ordered = inHLCOrder(records)
		var clearedAt: [Nonce: HybridLogicalClock] = [:]
		for record in ordered {
			if case .proposalCleared(let body) = record.body, body.chatId == chatId {
				clearedAt[body.nonce] = record.hlc
			}
		}
		for record in ordered.reversed() {
			guard case .pendingProposal(let body) = record.body, body.chatId == chatId else { continue }
			if body.expiresAt <= now { continue }
			if let cleared = clearedAt[body.nonce], record.hlc < cleared { continue }
			return body
		}
		return nil
	}
}

private func inHLCOrder(_ records: [AthleteRecord]) -> [AthleteRecord] {
	records.sorted { $0.hlc < $1.hlc }
}

import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct HistoryWindowTests {
	@Test func budgetMatchesEstimatorFormula() {
		let budget = HistoryWindow.historyTokenBudget(systemTokens: 4_000, window: 200_000, ratio: 0.3)
		#expect(budget == max(Int((200_000.0 * 0.3).rounded(.down)) - 4_000 - 20_000, TurnPolicy.historyBudgetFloor))
		let small = HistoryWindow.historyTokenBudget(systemTokens: 80_000, window: 200_000, ratio: 0.3)
		#expect(small == TurnPolicy.historyBudgetFloor)
	}

	@Test func trimDropsOldestAndKeepsAtLeastOne() {
		let messages = (0..<20).map { index in
			ChatMessage(role: index.isMultiple(of: 2) ? .user : .assistant, text: String(repeating: "x", count: 8_000))
		}
		let result = HistoryWindow.trim(messages: messages, systemTokens: 1_000)
		#expect(!result.kept.isEmpty)
		#expect(result.kept.count + result.dropped.count == messages.count)
		#expect(result.dropped.count >= 1)
		#expect(result.kept.last == messages.last)
	}

	@Test func softFlushUsesStrictThresholdAndCooldown() {
		#expect(HistoryWindow.shouldSoftFlush(historyTokens: 81, budget: 100, messagesSinceFlush: 5))
		#expect(HistoryWindow.shouldSoftFlush(historyTokens: 80, budget: 100, messagesSinceFlush: 5) == false)
		#expect(HistoryWindow.shouldSoftFlush(historyTokens: 90, budget: 100, messagesSinceFlush: 4) == false)
	}
}

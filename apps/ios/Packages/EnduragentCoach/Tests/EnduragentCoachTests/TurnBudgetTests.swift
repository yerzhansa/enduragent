import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct TurnBudgetTests {
	@Test func chargesFortyGeneratesAndFourAttempts() throws {
		var budget = TurnBudget.start()
		for _ in 0..<TurnPolicy.maxGenerateCalls {
			try budget.chargeGenerate()
		}
		#expect(throws: TurnBudgetExceeded.self) {
			try budget.chargeGenerate()
		}
		var attempts = TurnBudget.start()
		for _ in 0..<TurnPolicy.maxAttempts {
			try attempts.chargeAttempt()
		}
		#expect(throws: TurnBudgetExceeded.self) {
			try attempts.chargeAttempt()
		}
	}

	@Test func remainingIsNonNegativeUntilWallClock() {
		let clock = ContinuousClock()
		let budget = TurnBudget.start(clock: clock)
		let remaining = budget.remaining(until: clock.now)
		#expect(remaining > .seconds(9 * 60))
		#expect(remaining <= TurnPolicy.wallClock)
		let exhausted = budget.remaining(until: budget.deadline.advanced(by: .seconds(1)))
		#expect(exhausted == .zero)
	}
}

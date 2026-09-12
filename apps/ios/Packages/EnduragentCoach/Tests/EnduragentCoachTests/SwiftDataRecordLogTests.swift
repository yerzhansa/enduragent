import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct SwiftDataRecordLogTests {
	let amsterdam = IANATimeZone(identifier: "Europe/Amsterdam")!
	let phoneA = DeviceID(rawValue: "phone-a")
	let phoneB = DeviceID(rawValue: "phone-b")
	let expires = Date(timeIntervalSince1970: 899_164_800)

	@Test func mixedLocalityQueryThrows() async throws {
		let log = try makeSwiftDataLog(deviceId: phoneA)
		await #expect(throws: MixedRecordLocalityQuery.self) {
			try await log.fetch(RecordQuery(kinds: [.userMessage, .pendingProposal]))
		}
	}

	@Test func appendRoutesByLocality() async throws {
		let log = try makeSwiftDataLog(deviceId: phoneA)
		try await log.append(record(device: phoneA, wall: 1, body: .userMessage(sampleUser(chatId: .main, text: "synced"))))
		try await log.append(
			record(
				device: phoneA,
				wall: 2,
				body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: expires))
			)
		)
		let synced = try await log.fetch(RecordQuery(kinds: [.userMessage]))
		let local = try await log.fetch(RecordQuery(kinds: [.pendingProposal]))
		#expect(synced.map(\.body.kind) == [.userMessage])
		#expect(local.map(\.body.kind) == [.pendingProposal])
		#expect(try await log.fetch(RecordQuery(kinds: [.assistantMessage])).isEmpty)
	}

	@Test func fetchSyncedIsUnionAndLocalIsThisDevice() async throws {
		let log = try makeSwiftDataLog(deviceId: phoneA)
		try await log.append(record(device: phoneB, wall: 1, body: .userMessage(sampleUser(chatId: .main, text: "from b"))))
		try await log.append(record(device: phoneA, wall: 2, body: .userMessage(sampleUser(chatId: .main, text: "from a"))))
		try await log.append(
			record(
				device: phoneA,
				wall: 3,
				body: .pendingProposal(sampleProposal(chatId: .main, nonce: Nonce(), expiresAt: expires))
			)
		)
		let synced = try await log.fetch(RecordQuery(kinds: [.userMessage]))
		#expect(Set(synced.map(\.deviceId)) == [phoneA, phoneB])
		let local = try await log.fetch(RecordQuery(kinds: [.pendingProposal]))
		#expect(local.map(\.deviceId) == [phoneA])
	}

	@Test func bodyRoundTripForEveryKind() async throws {
		let log = try makeSwiftDataLog(deviceId: phoneA)
		let samples = sampleBodies()
		#expect(Set(samples.map(\.kind)) == Set(RecordKind.allCases))
		for (index, sample) in samples.enumerated() {
			try await log.append(record(device: phoneA, wall: Int64(index + 1), body: sample.body))
		}
		let synced = try await log.fetch(RecordQuery(kinds: Set(RecordKind.allCases.filter { $0.locality == .synced })))
		let local = try await log.fetch(RecordQuery(kinds: Set(RecordKind.allCases.filter { $0.locality == .deviceLocal })))
		let fetched = Dictionary(uniqueKeysWithValues: (synced + local).map { ($0.body.kind, $0.body) })
		for sample in samples {
			#expect(fetched[sample.kind] == sample.body)
		}
	}

	private func record(
		device: DeviceID,
		wall: Int64,
		body: RecordBody
	) -> AthleteRecord {
		AthleteRecord(
			ulid: ULID.generate(at: Date(timeIntervalSince1970: TimeInterval(wall))),
			deviceId: device,
			hlc: HybridLogicalClock(wallMs: wall, logical: 0, deviceId: device),
			timeZone: amsterdam,
			civilDate: "1998-06-13",
			body: body
		)
	}

	private func sampleBodies() -> [(kind: RecordKind, body: RecordBody)] {
		let ulid = ULID.generate(at: Date(timeIntervalSince1970: 899_164_800))
		let workout = IntervalsWorkoutInput(
			name: "Z2",
			steps: [
				.simple(
					SimpleStep(
						type: .warmup,
						duration: DurationInput(value: 10, unit: .minutes),
						power: PowerTarget(kind: .percentFtp, value: 55, low: nil, high: nil),
						cadence: CadenceTarget(value: 90, low: nil, high: nil),
						label: "wu"
					)
				),
				.set(
					SetStep(
						repeatCount: 3,
						interval: SimpleStep(
							type: .interval,
							duration: DurationInput(value: 30, unit: .seconds),
							power: PowerTarget(kind: .watts, value: 200, low: nil, high: nil),
							cadence: nil,
							label: nil
						),
						recovery: SimpleStep(
							type: .rest,
							duration: DurationInput(value: 15, unit: .seconds),
							power: nil,
							cadence: nil,
							label: nil
						)
					)
				),
			]
		)
		return [
			(
				.userMessage,
				.userMessage(
					UserMessageBody(chatId: .main, athleteText: "hi", timedText: "hi /review", slash: .review)
				)
			),
			(.assistantMessage, .assistantMessage(sampleAssistant(chatId: .main, text: "hello"))),
			(.windowStart, .windowStart(WindowStartBody(chatId: .main, firstIncludedUlid: ulid))),
			(.compactionSummary, .compactionSummary(CompactionSummaryBody(chatId: .main, markdown: "sum"))),
			(.memorySection, .memorySection(MemorySectionBody(name: .person, content: "Ada"))),
			(.dailyNote, .dailyNote(DailyNoteBody(note: "note"))),
			(.ledgerEvent, .ledgerEvent(LedgerEventBody(kind: .decision, text: "Keep Saturdays free.", source: .chat))),
			(.journal, .journal(JournalBody(op: .writeSection, preview: "person"))),
			(
				.provenance,
				.provenance(
					ProvenanceBody(key: "k", garmin: true, nonGarmin: false, unknown: false, contentSha256: "abc")
				)
			),
			(
				.pendingProposal,
				.pendingProposal(
					ProposalBody(
						chatId: .main,
						nonce: Nonce(rawValue: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!),
						tool: .intervalsCreateWorkout,
						toolInput: .createWorkout(date: "1998-06-13", workout: workout),
						summary: "Z2",
						description: "Z2 ride",
						expiresAt: expires
					)
				)
			),
			(
				.proposalCleared,
				.proposalCleared(
					ProposalClearedBody(chatId: .main, nonce: Nonce(rawValue: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!), reason: .executed)
				)
			),
			(
				.flushPending,
				.flushPending(FlushPendingBody(chatId: .main, trigger: .trim, messageUlids: [ulid]))
			),
			(.coachReplyLanguage, .coachReplyLanguage(CoachReplyLanguageBody(tag: .it))),
			(
				.planningDevice,
				.planningDevice(
					PlanningDeviceBody(planningDeviceId: phoneA, planUlid: ulid, activatedAt: expires)
				)
			),
			(
				.planningCommand,
				.planningCommand(
					PlanningCommandBody(
						commandName: .creationStart,
						commandId: "cmd-1",
						requestDigest: "digest",
						status: .succeeded,
						result: .object([
							"ok": .bool(true),
							"n": .number(2),
							"s": .string("x"),
							"z": .null,
							"a": .array([.number(1)]),
						])
					)
				)
			),
			(
				.planRevision,
				.planRevision(
					PlanRevisionBody(planUlid: ulid, version: 1, status: .active, snapshot: .object(["name": .string("Base")]))
				)
			),
			(
				.mirrorJob,
				.mirrorJob(
					MirrorJobBody(
						planUlid: ulid,
						kind: .mirror,
						windowStart: DateKey.from("1998-06-13"),
						windowEnd: DateKey.from("1998-06-19"),
						failureCount: 0
					)
				)
			),
			(
				.workoutMatch,
				.workoutMatch(
					WorkoutMatchBody(planWorkoutId: ulid, activityId: "123456", decision: .confirmed)
				)
			),
			(.workoutDrift, .workoutDrift(WorkoutDriftBody(planWorkoutId: ulid, askedAt: expires))),
		]
	}
}

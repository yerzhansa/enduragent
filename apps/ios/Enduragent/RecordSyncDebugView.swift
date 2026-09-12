#if DEBUG
import EnduragentCoach
import SwiftUI

struct RecordSyncDebugView: View {
	@State private var session: RecordSyncSession?
	@State private var loadError: String?
	@State private var status = ""
	@State private var deviceIdText = ""
	@State private var newestHLC = ""
	@State private var counts: [(kind: String, count: Int)] = []
	@State private var rows: [RecordSyncRow] = []

	var body: some View {
		NavigationStack {
			List {
				Section("Device") {
					Text(deviceIdText.isEmpty ? "—" : deviceIdText)
				}
				Section("Newest HLC") {
					Text(newestHLC.isEmpty ? "—" : newestHLC)
				}
				Section("Count per kind") {
					if counts.isEmpty {
						Text("No records")
					} else {
						ForEach(counts, id: \.kind) { item in
							HStack {
								Text(item.kind)
								Spacer()
								Text("\(item.count)")
							}
						}
					}
				}
				Section("Records") {
					ForEach(rows) { row in
						VStack(alignment: .leading, spacing: 4) {
							Text(row.kind)
							Text(row.deviceId)
								.font(.caption)
							Text(row.hlc)
								.font(.caption2)
								.monospaced()
						}
					}
				}
				Section("Append") {
					Button("Append three synced records") {
						Task { await appendSynced() }
					}
					Button("Append one device-local record") {
						Task { await appendLocal() }
					}
					Button("Refresh") {
						Task { await refresh() }
					}
				}
				if let loadError {
					Section("Error") {
						Text(loadError)
					}
				} else if !status.isEmpty {
					Section("Status") {
						Text(status)
					}
				}
			}
			.navigationTitle("Record Sync")
			.task { await bootstrap() }
		}
	}

	@MainActor
	private func bootstrap() async {
		do {
			if session == nil {
				session = try RecordSyncSession()
			}
			await refresh()
		} catch {
			loadError = String(describing: error)
		}
	}

	@MainActor
	private func refresh() async {
		guard let session else { return }
		do {
			let records = try await session.fetchAll()
			deviceIdText = session.deviceId.rawValue
			counts = RecordKind.allCases.compactMap { kind in
				let count = records.filter { $0.body.kind == kind }.count
				return count == 0 ? nil : (kind.rawValue, count)
			}
			if let newest = records.max(by: { $0.hlc < $1.hlc }) {
				newestHLC = hlcText(newest.hlc)
			} else {
				newestHLC = ""
			}
			rows = records.map { record in
				RecordSyncRow(
					id: "\(record.ulid.rawValue)-\(record.deviceId.rawValue)",
					kind: record.body.kind.rawValue,
					deviceId: record.deviceId.rawValue,
					hlc: hlcText(record.hlc)
				)
			}
			loadError = nil
		} catch {
			loadError = String(describing: error)
		}
	}

	@MainActor
	private func appendSynced() async {
		guard let session else { return }
		do {
			try await session.appendSyncedSamples()
			status = "Appended three synced records"
			await refresh()
		} catch {
			loadError = String(describing: error)
		}
	}

	@MainActor
	private func appendLocal() async {
		guard let session else { return }
		do {
			try await session.appendLocalSample()
			status = "Appended one device-local record"
			await refresh()
		} catch {
			loadError = String(describing: error)
		}
	}
}

private struct RecordSyncRow: Identifiable {
	var id: String
	var kind: String
	var deviceId: String
	var hlc: String
}

@MainActor
private final class RecordSyncSession {
	static let deviceDefaultsKey = "enduragent.deviceId"

	let deviceId: DeviceID
	let log: SwiftDataRecordLog

	init() throws {
		let defaults = UserDefaults.standard
		if let stored = defaults.string(forKey: Self.deviceDefaultsKey) {
			deviceId = DeviceID(rawValue: stored)
		} else {
			let created = DeviceID()
			defaults.set(created.rawValue, forKey: Self.deviceDefaultsKey)
			deviceId = created
		}
		let directory = try ModelContainerHandle.applicationSupportDirectory()
		log = SwiftDataRecordLog(
			deviceId: deviceId,
			synced: try ModelContainerHandle.syncedCloudKit(directory: directory),
			local: try ModelContainerHandle.deviceLocal(directory: directory)
		)
	}

	func fetchAll() async throws -> [AthleteRecord] {
		let synced = try await log.fetch(RecordQuery(kinds: Set(RecordKind.allCases.filter { $0.locality == .synced })))
		let local = try await log.fetch(RecordQuery(kinds: Set(RecordKind.allCases.filter { $0.locality == .deviceLocal })))
		return (synced + local).sorted { $0.hlc < $1.hlc }
	}

	func appendSyncedSamples() async throws {
		let now = Date()
		for index in 0..<3 {
			let stamped = now.addingTimeInterval(TimeInterval(index))
			try await log.append(
				RecordLogSamples.record(
					deviceId: deviceId,
					now: stamped,
					body: RecordLogSamples.userMessage(text: "synced-\(index + 1)")
				)
			)
		}
	}

	func appendLocalSample() async throws {
		let now = Date()
		try await log.append(
			RecordLogSamples.record(
				deviceId: deviceId,
				now: now,
				body: RecordLogSamples.pendingProposal(expiresAt: now.addingTimeInterval(600))
			)
		)
	}
}

private func hlcText(_ hlc: HybridLogicalClock) -> String {
	"\(hlc.wallMs).\(hlc.logical)@\(hlc.deviceId.rawValue)"
}
#endif

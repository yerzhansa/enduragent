import Foundation
import SwiftData

extension ModelContainerHandle {
	public static let cloudKitContainerIdentifier = "iCloud.icu.enduragent.ios"
	public static let syncedStoreFileName = "synced-records.store"
	public static let localStoreFileName = "local-records.store"

	public static func applicationSupportDirectory() throws -> URL {
		let root = try FileManager.default.url(
			for: .applicationSupportDirectory,
			in: .userDomainMask,
			appropriateFor: nil,
			create: true
		)
		let directory = root.appending(path: "EnduragentCoach", directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		return directory
	}

	public static func syncedCloudKit(directory: URL) throws -> ModelContainerHandle {
		try make(
			name: "synced-records",
			storeURL: directory.appending(path: syncedStoreFileName),
			cloudKitDatabase: .private(cloudKitContainerIdentifier)
		)
	}

	public static func deviceLocal(directory: URL) throws -> ModelContainerHandle {
		try make(
			name: "local-records",
			storeURL: directory.appending(path: localStoreFileName),
			cloudKitDatabase: .none
		)
	}

	public static func withoutCloudKit(storeURL: URL) throws -> ModelContainerHandle {
		try make(
			name: storeURL.lastPathComponent,
			storeURL: storeURL,
			cloudKitDatabase: .none
		)
	}

	private static func make(
		name: String,
		storeURL: URL,
		cloudKitDatabase: ModelConfiguration.CloudKitDatabase
	) throws -> ModelContainerHandle {
		let schema = Schema([StoredAthleteRecord.self])
		let parent = storeURL.deletingLastPathComponent()
		try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
		let configuration = ModelConfiguration(
			name,
			schema: schema,
			url: storeURL,
			cloudKitDatabase: cloudKitDatabase
		)
		return ModelContainerHandle(container: try ModelContainer(for: schema, configurations: [configuration]))
	}
}

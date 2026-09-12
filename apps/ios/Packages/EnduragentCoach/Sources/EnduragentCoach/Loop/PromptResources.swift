import Foundation

package enum PromptResources {
	package static func soul() -> String {
		utf8(resource: "SOUL", subdirectory: "PromptResources")
	}

	package static func skillBody(key: String) -> String {
		let file = String(key.dropFirst("cycling-".count))
		return utf8(resource: file, subdirectory: "PromptResources/skills")
	}

	package static func cyclingSkills() -> [(key: String, body: String)] {
		PromptAssembly.skillKeys.map { key in
			(key: key, body: skillBody(key: key))
		}
	}

	private static func utf8(resource: String, subdirectory: String) -> String {
		guard let url = Bundle.module.url(forResource: resource, withExtension: "md", subdirectory: subdirectory) else {
			return ""
		}
		return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
	}
}

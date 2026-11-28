import { describe, expect, it, vi } from "vitest";
import { createSafeUpdaterLogger, formatUpdaterDiagnostic } from "../src/main/updater-logger.js";

describe("safe updater diagnostic logger", () => {
  it("classifies differential fallback causes without leaking URLs, headers, or user paths", () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        'Cannot download differentially, fallback to full download: HttpError: 502 Bad Gateway\nHeaders: {"authorization":"Bearer top-secret"}\n    at createHttpError (/Users/athlete/Library/app.js:12:3)',
        "desktop-update-updater level=error event=differential-fallback reason=http-error status=502",
      ],
      [
        'Cannot download differentially, fallback to full download: Error: Cannot download "https://updates.enduragent.icu/Enduragent-0.6.0-arm64.zip.blockmap?token=secret123", status 404: Not Found',
        "desktop-update-updater level=error event=differential-fallback reason=http-error status=404",
      ],
      [
        'Cannot download differentially, fallback to full download: Error: Content-Type "multipart/byteranges" is expected, but got "application/octet-stream"',
        "desktop-update-updater level=error event=differential-fallback reason=multipart-ranges-unsupported",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: Response ends without calling any handlers",
        "desktop-update-updater level=error event=differential-fallback reason=multipart-response-incomplete",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: Server doesn't support Accept-Ranges (response code 200)",
        "desktop-update-updater level=error event=differential-fallback reason=ranges-unsupported status=200",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: ENOENT: no such file or directory, open '/Users/athlete/Library/Caches/@enduragentdesktop-updater/update.zip'",
        "desktop-update-updater level=error event=differential-fallback reason=missing-cached-package code=ENOENT",
      ],
      [
        'Cannot download differentially, fallback to full download: Error: Cannot parse blockmap "https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip.blockmap?sig=abc", error: Error: incorrect header check',
        "desktop-update-updater level=error event=differential-fallback reason=blockmap-invalid",
      ],
      [
        'Cannot download differentially, fallback to full download: Error: Blockmap "https://updates.enduragent.icu/old.blockmap?sig=abc" is empty',
        "desktop-update-updater level=error event=differential-fallback reason=blockmap-invalid",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: version is different (1 - 2), full download is required",
        "desktop-update-updater level=error event=differential-fallback reason=blockmap-version-mismatch",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: Internal error, size mismatch: downloadSize: 10, copySize: 20, newSize: 40",
        "desktop-update-updater level=error event=differential-fallback reason=size-mismatch",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: sha512 checksum mismatch, expected abc, got def",
        "desktop-update-updater level=error event=differential-fallback reason=checksum-mismatch",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: response has been aborted by the server",
        "desktop-update-updater level=error event=differential-fallback reason=response-aborted",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: net::ERR_CONNECTION_RESET",
        "desktop-update-updater level=error event=differential-fallback reason=network-error code=net::ERR_CONNECTION_RESET",
      ],
      [
        "Cannot download differentially, fallback to full download: Error: unexpected failure with /Users/athlete/secret",
        "desktop-update-updater level=error event=differential-fallback reason=unknown",
      ],
    ];

    for (const [input, expected] of cases) {
      const formatted = formatUpdaterDiagnostic("error", input);
      expect(formatted).toBe(expected);
      expect(formatted).not.toContain("/Users/athlete");
      expect(formatted).not.toContain("secret");
      expect(formatted).not.toContain("https://");
      expect(formatted).not.toContain("Bearer");
    }
  });

  it("ignores response headers and stack frames that could spoof reasons or leak data", () => {
    const formatted = formatUpdaterDiagnostic(
      "error",
      [
        "Cannot download differentially, fallback to full download: HttpError: 502 Bad Gateway",
        'Headers: {"x-custom":"ENOENT sha512 checksum https://private.invalid/?token=leak"}',
        "    at /Users/athlete/Library/Caches/@enduragentdesktop-updater/update.zip",
      ].join("\n"),
    );
    expect(formatted).toBe(
      "desktop-update-updater level=error event=differential-fallback reason=http-error status=502",
    );
  });

  it("records differential metrics and lifecycle milestones while suppressing noisy or identifying info", () => {
    const log = vi.fn();
    const logger = createSafeUpdaterLogger(log);

    logger.info("Checking for update");
    logger.info(
      "Found version 0.7.0 (url: Enduragent-0.7.0-arm64.zip, https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip?sig=secret)",
    );
    logger.info(
      "Unable to locate previous update.zip for differential download (is this first install?), falling back to full download",
    );
    logger.info(
      'Download block maps (old: "https://updates.enduragent.icu/Enduragent-0.6.0-arm64.zip.blockmap?sig=1", new: https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip.blockmap?sig=2)',
    );
    logger.info("File has 44 changed blocks");
    logger.info("Full: 150,104.24 KB, To download: 33,690.50 KB (22%)");
    logger.info(
      "Differential download: https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip?sig=secret",
    );
    logger.info("Redirect to https://objects.githubusercontent.com/private/path");
    logger.info(
      "New version 0.7.0 has been downloaded to /Users/athlete/Library/Caches/@enduragentdesktop-updater/pending/Enduragent-0.7.0-arm64.zip",
    );
    logger.info("Generated new staging user ID: 123e4567-e89b-12d3-a456-426614174000");
    logger.info(
      "/deadbeefdeadbeef.zip requested by Squirrel.Mac, pipe /Users/athlete/Library/Caches/update.zip",
    );
    logger.info("Checked for macOS Rosetta environment (isRosetta=false)");

    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      "desktop-update-updater level=info event=check-start",
      "desktop-update-updater level=info event=update-available version=0.7.0",
      "desktop-update-updater level=info event=differential-skipped reason=missing-cached-package",
      "desktop-update-updater level=info event=differential-blockmaps",
      "desktop-update-updater level=info event=differential-plan changedBlocks=44",
      "desktop-update-updater level=info event=differential-summary fullKb=150104.24 downloadKb=33690.50 percent=22",
      "desktop-update-updater level=info event=differential-download-start",
      "desktop-update-updater level=info event=redirect",
      "desktop-update-updater level=info event=download-complete version=0.7.0",
    ]);
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("/Users/athlete");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("secret");
  });

  it("handles raw Error instances and warnings safely without leaking arbitrary text", () => {
    const log = vi.fn();
    const logger = createSafeUpdaterLogger(log);
    const httpError = Object.assign(
      new Error("404 Not Found https://private.invalid/?token=secret"),
      { statusCode: 404, code: "HTTP_ERROR_404" },
    );
    const updaterError = Object.assign(new Error("Missing /Users/athlete/file.zip"), {
      code: "ERR_UPDATER_ZIP_FILE_NOT_FOUND",
    });

    logger.warn(httpError);
    logger.error(updaterError);
    logger.warn(
      "Unable to copy file for caching for future differential downloads: EACCES: permission denied, copyfile '/Users/athlete/a' -> '/Users/athlete/b'",
    );
    logger.warn(
      'Cannot parse blockmap "/Users/athlete/Library/Caches/current.blockmap", error: SyntaxError',
    );
    logger.warn(
      "Sha512 checksum doesn't match the latest available update. New update must be downloaded. Cached: aaa, expected: bbb",
    );

    expect(log.mock.calls.map(([entry]) => entry)).toEqual([
      "desktop-update-updater level=warn event=updater-warning status=404",
      "desktop-update-updater level=error event=updater-error code=ERR_UPDATER_ZIP_FILE_NOT_FOUND",
      "desktop-update-updater level=warn event=differential-cache-save-failed code=EACCES",
      "desktop-update-updater level=warn event=cached-blockmap-invalid",
      "desktop-update-updater level=warn event=cached-package-checksum-mismatch",
    ]);
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("/Users/athlete");
    expect(serialized).not.toContain("secret");
  });
});

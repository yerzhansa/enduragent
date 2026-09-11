#!/usr/bin/env tsx

import { DESKTOP_FEED_URL, handleDesktopUpdateFeedRequest } from "./desktop-update-feed.js";

const response = await handleDesktopUpdateFeedRequest(
  new Request(`${DESKTOP_FEED_URL}latest-mac.yml?noCache=probe`),
);
const body = await response.text();
const location = response.headers.get("location");
if (response.status !== 200 || location !== null || !/^version: /mu.test(body)) {
  process.stderr.write(
    `desktop update feed probe failed status=${response.status} location=${location ?? ""} body=${body.slice(0, 200)}\n`,
  );
  process.exit(1);
}
process.stdout.write(body);

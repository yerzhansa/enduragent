import { handleDesktopUpdateFeedRequest } from "./desktop-update-feed.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleDesktopUpdateFeedRequest(request);
  },
};

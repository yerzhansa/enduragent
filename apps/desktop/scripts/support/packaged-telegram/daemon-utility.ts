import { installTelegramFetchRoute, requireAcceptanceOrigin } from "./telegram-fetch-route.js";
import { installOAuthAcceptanceRoute } from "./oauth-fetch-route.js";

const origin = requireAcceptanceOrigin(process.env.ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN);
delete process.env.ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN;
installTelegramFetchRoute(origin);
installOAuthAcceptanceRoute("utility");
await import("../../../src/utility/daemon.js");

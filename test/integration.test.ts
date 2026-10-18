import { healthConversation } from "./integration/health.ts";
import { hopLimit } from "./integration/hop-limit.ts";
import { restartListener } from "./integration/restart.ts";
import { test } from "./integration/support.ts";
import { wakeRange } from "./integration/wake-range.ts";

test("health, viewer, and an agent conversation", healthConversation);

test(
  "the hop limit pauses the next agent post, including two posts at once",
  hopLimit
);

test(
  "a delivered wake carries the unseen seq range and the next wake starts after it",
  wakeRange
);

test(
  "a failed harness posts @human and a restarted listener marks the saved range read",
  restartListener
);

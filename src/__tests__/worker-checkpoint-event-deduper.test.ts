import { describe, expect, test } from "bun:test";

import { ralphEventBus } from "../dashboard/bus";
import { buildRalphEvent } from "../dashboard/events";
import { CheckpointEventDeduper } from "../worker/events";

describe("CheckpointEventDeduper", () => {
  test("suppresses duplicate publishes when persistent claim rejects key", () => {
    const seen = new Set<string>();
    const deduper = new CheckpointEventDeduper({
      claimKey: (key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });

    const published: string[] = [];
    const unsubscribe = ralphEventBus.subscribe((event) => {
      if (event.type === "worker.checkpoint.reached") {
        const checkpoint = typeof event.data?.checkpoint === "string" ? event.data.checkpoint : "";
        published.push(checkpoint);
      }
    });

    try {
      const event = buildRalphEvent({
        type: "worker.checkpoint.reached",
        level: "info",
        data: { checkpoint: "implementation_step_complete" },
      });
      const key = "worker.checkpoint.reached:worker:implementation_step_complete:7";

      deduper.emit(event, key);
      deduper.emit(event, key);

      expect(published).toEqual(["implementation_step_complete"]);
    } finally {
      unsubscribe();
    }
  });
});

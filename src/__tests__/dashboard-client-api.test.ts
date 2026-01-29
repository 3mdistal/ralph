import { describe, expect, test } from "bun:test";

import { RalphEventBus } from "../dashboard/event-bus";
import { buildRalphEvent } from "../dashboard/events";
import { startControlPlaneServer } from "../dashboard/control-plane-server";
import type { StatusSnapshot } from "../status-snapshot";
import { connectControlPlaneEvents, fetchControlPlaneState } from "../dashboard/client/api";

function createSnapshot(): StatusSnapshot {
  return {
    mode: "running",
    queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
    daemon: null,
    controlProfile: null,
    activeProfile: null,
    throttle: { state: "ok" },
    usage: { profiles: [] },
    escalations: { pending: 0 },
    inProgress: [],
    starting: [],
    queued: [],
    throttled: [],
    blocked: [],
    drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null },
  };
}

function waitFor<T>(label: string, fn: (resolve: (value: T) => void, reject: (err: Error) => void) => void, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    fn(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

describe("dashboard client api", () => {
  test("fetches state with auth", async () => {
    const bus = new RalphEventBus();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const state = await fetchControlPlaneState(server.url, "secret");
      expect(state.mode).toBe("running");
    } finally {
      server.stop();
    }
  });

  test("streams events via protocol auth", async () => {
    const bus = new RalphEventBus({ bufferSize: 5 });
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      replayLastDefault: 0,
      replayLastMax: 5,
    });

    try {
      const replayEvent = buildRalphEvent({ type: "daemon.started", level: "info", data: {} });
      bus.publish(replayEvent);

      const received = await waitFor<string>("event", (resolve, reject) => {
        connectControlPlaneEvents({
          baseUrl: server.url,
          token: "secret",
          replayLast: 1,
          handlers: {
            onEvent: (event) => resolve(event.type),
            onStatus: () => undefined,
            onError: reject,
          },
        });
      });

      expect(received).toBe("daemon.started");
    } finally {
      server.stop();
    }
  });
});

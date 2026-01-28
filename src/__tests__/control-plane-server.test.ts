import { describe, expect, test } from "bun:test";

import { RalphEventBus } from "../dashboard/event-bus";
import { buildRalphEvent } from "../dashboard/events";
import { startControlPlaneServer } from "../dashboard/control-plane-server";
import type { StatusSnapshot } from "../status-snapshot";

function createSnapshot(): StatusSnapshot {
  return {
    mode: "running",
    queue: { backend: "github", health: "ok", fallback: false, diagnostics: null },
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

describe("control plane server", () => {
  test("rejects missing token", async () => {
    const bus = new RalphEventBus();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/v1/state`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body?.error?.code).toBe("unauthorized");
    } finally {
      server.stop();
    }
  });

  test("returns snapshot with auth", async () => {
    const bus = new RalphEventBus();
    const snapshot = createSnapshot();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => snapshot,
      token: "secret",
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/v1/state`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.mode).toBe("running");
      expect(body.queue.backend).toBe("github");
    } finally {
      server.stop();
    }
  });

  test("streams events with replay", async () => {
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

      const ws = new WebSocket(`${server.url.replace("http", "ws")}/v1/events?access_token=secret&replayLast=1`);
      const firstMessage = await waitFor<string>("ws message", (resolve, reject) => {
        ws.addEventListener("error", () => reject(new Error("ws error")));
        ws.addEventListener("message", (event) => resolve(String(event.data)));
      });
      const parsed = JSON.parse(firstMessage);
      expect(parsed.type).toBe("daemon.started");

      const liveEvent = buildRalphEvent({ type: "log.worker", level: "info", data: { message: "hi" } });
      const liveMessage = await waitFor<string>("ws live message", (resolve) => {
        ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        bus.publish(liveEvent);
      });
      const parsedLive = JSON.parse(liveMessage);
      expect(parsedLive.type).toBe("log.worker");

      ws.close();
    } finally {
      server.stop();
    }
  });

  test("filters raw opencode events by default", async () => {
    const bus = new RalphEventBus({ bufferSize: 5 });
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/v1/events?access_token=secret`);
      await waitFor<void>("ws open", (resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });

      const seen: string[] = [];
      ws.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data));
        seen.push(parsed.type);
      });

      bus.publish(buildRalphEvent({ type: "log.opencode.event", level: "info", data: { event: { secret: "x" } } }));
      bus.publish(buildRalphEvent({ type: "log.worker", level: "info", data: { message: "ok" } }));

      await waitFor<void>("ws filtered", (resolve, reject) => {
        const timer = setInterval(() => {
          if (seen.includes("log.worker")) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
        setTimeout(() => {
          clearInterval(timer);
          reject(new Error("timeout waiting for log.worker"));
        }, 2000);
      });

      expect(seen.includes("log.opencode.event")).toBe(false);
      ws.close();
    } finally {
      server.stop();
    }
  });
});

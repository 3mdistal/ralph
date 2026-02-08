import { describe, expect, test } from "bun:test";

import { RalphEventBus } from "../dashboard/event-bus";
import { ControlPlaneHttpError } from "../dashboard/control-plane-errors";
import { buildRalphEvent } from "../dashboard/events";
import { ControlPlaneCommandError, startControlPlaneServer } from "../dashboard/control-plane-server";
import type { StatusSnapshot } from "../status-snapshot";

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

  test("redacts state snapshots", async () => {
    const bus = new RalphEventBus();
    const snapshot = createSnapshot();
    snapshot.queue.diagnostics = "ghp_1234567890123456789012345";
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
      expect(body.queue.diagnostics).toBe("ghp_[REDACTED]");
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

  test("streams raw opencode events when enabled", async () => {
    const bus = new RalphEventBus({ bufferSize: 5 });
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      exposeRawOpencodeEvents: true,
    });

    try {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/v1/events?access_token=secret`);
      await waitFor<void>("ws open", (resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });

      const message = await waitFor<string>("ws message", (resolve) => {
        ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        bus.publish(buildRalphEvent({ type: "log.opencode.event", level: "info", data: { event: { secret: "x" } } }));
      });
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("log.opencode.event");

      ws.close();
    } finally {
      server.stop();
    }
  });

  test("executes pause/resume commands", async () => {
    const bus = new RalphEventBus();
    let seenPause: any = null;
    let seenResume: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async (params) => {
          seenPause = params;
        },
        resume: async (params) => {
          seenResume = params;
        },
        enqueueMessage: async () => ({ id: "n1" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
      },
    });

    try {
      const pauseRes = await fetch(`${server.url}/v1/commands/pause`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ workerId: "w1", reason: "operator" }),
      });
      expect(pauseRes.status).toBe(200);
      expect(seenPause?.workerId).toBe("w1");
      expect(seenPause?.reason).toBe("operator");

      const resumeRes = await fetch(`${server.url}/v1/commands/resume`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ workerId: "w1" }),
      });
      expect(resumeRes.status).toBe(200);
      expect(seenResume?.workerId).toBe("w1");
    } finally {
      server.stop();
    }
  });

  test("enqueue message requires json and text", async () => {
    const bus = new RalphEventBus();
    let seenEnqueue: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async (params) => {
          seenEnqueue = params;
          return { id: "n2" };
        },
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
      },
    });

    try {
      const badType = await fetch(`${server.url}/v1/commands/message/enqueue`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "text/plain" },
        body: "nope",
      });
      expect(badType.status).toBe(415);

      const missingText = await fetch(`${server.url}/v1/commands/message/enqueue`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1" }),
      });
      expect(missingText.status).toBe(400);

      const ok = await fetch(`${server.url}/v1/commands/message/enqueue`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: "hello" }),
      });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.ok).toBe(true);
      expect(body.id).toBe("n2");
      expect(seenEnqueue?.sessionId).toBe("ses_1");
      expect(seenEnqueue?.text).toBe("hello");
    } finally {
      server.stop();
    }
  });

  test("interrupt messaging returns 501 when disabled", async () => {
    const bus = new RalphEventBus();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n3" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
      },
    });

    try {
      const res = await fetch(`${server.url}/v1/commands/message/interrupt`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_1", text: "stop" }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body?.error?.code).toBe("not_implemented");
    } finally {
      server.stop();
    }
  });

  test("set task priority calls handler", async () => {
    const bus = new RalphEventBus();
    let seen: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n4" }),
        setTaskPriority: async (params) => {
          seen = params;
        },
        setTaskStatus: async () => {},
      },
    });

    try {
      const res = await fetch(`${server.url}/v1/commands/task/priority`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "github:owner/repo#123", priority: "p1" }),
      });
      expect(res.status).toBe(200);
      expect(seen?.taskId).toBe("github:owner/repo#123");
      expect(seen?.priority).toBe("p1");
    } finally {
      server.stop();
    }
  });

  test("set task status calls handler", async () => {
    const bus = new RalphEventBus();
    let seen: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n5" }),
        setTaskPriority: async () => {},
        setTaskStatus: async (params) => {
          seen = params;
        },
      },
    });

    try {
      const res = await fetch(`${server.url}/v1/commands/task/status`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "github:owner/repo#123", status: "queue" }),
      });
      expect(res.status).toBe(200);
      expect(seen?.taskId).toBe("github:owner/repo#123");
      expect(seen?.status).toBe("queue");
    } finally {
      server.stop();
    }
  });

  test("set issue priority calls handler", async () => {
    const bus = new RalphEventBus();
    let seen: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n5" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
        setIssuePriority: async (params) => {
          seen = params;
        },
      },
    });

    try {
      const missing = await fetch(`${server.url}/v1/commands/issue/priority`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "", issueNumber: 123, priority: "p1" }),
      });
      expect(missing.status).toBe(400);

      const res = await fetch(`${server.url}/v1/commands/issue/priority`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "owner/repo", issueNumber: 123, priority: "p1" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.accepted).toBe(true);
      expect(seen?.repo).toBe("owner/repo");
      expect(seen?.issueNumber).toBe(123);
      expect(seen?.priority).toBe("p1");
    } finally {
      server.stop();
    }
  });

  test("set task status validates missing status", async () => {
    const bus = new RalphEventBus();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n6" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
      },
    });

    try {
      const res = await fetch(`${server.url}/v1/commands/task/status`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "github:owner/repo#123" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body?.error?.code).toBe("bad_request");
    } finally {
      server.stop();
    }
  });

  test("issue cmd validates and calls handler", async () => {
    const bus = new RalphEventBus();
    let seen: any = null;
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n6" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {},
        enqueueIssueCommand: async (params) => {
          seen = params;
        },
      },
    });

    try {
      const invalid = await fetch(`${server.url}/v1/commands/issue/cmd`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "owner/repo", issueNumber: 123, cmd: "invalid" }),
      });
      expect(invalid.status).toBe(400);

      const res = await fetch(`${server.url}/v1/commands/issue/cmd`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "owner/repo", issueNumber: 123, cmd: "queue" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.accepted).toBe(true);
      expect(seen?.repo).toBe("owner/repo");
      expect(seen?.issueNumber).toBe(123);
      expect(seen?.cmd).toBe("queue");
    } finally {
      server.stop();
    }
  });

  test("returns typed control-plane errors", async () => {
    const bus = new RalphEventBus();
    const server = startControlPlaneServer({
      bus,
      getStateSnapshot: async () => createSnapshot(),
      token: "secret",
      host: "127.0.0.1",
      port: 0,
      commands: {
        pause: async () => {},
        resume: async () => {},
        enqueueMessage: async () => ({ id: "n7" }),
        setTaskPriority: async () => {},
        setTaskStatus: async () => {
          throw new ControlPlaneCommandError(400, "unsupported_task_id", "Only github taskIds are supported");
        },
        setIssuePriority: async () => {
          throw new ControlPlaneHttpError(503, "github_transient", "temporary outage");
        },
      },
    });

    try {
      const taskRes = await fetch(`${server.url}/v1/commands/task/status`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "legacy:path", status: "queue" }),
      });
      expect(taskRes.status).toBe(400);
      const taskBody = await taskRes.json();
      expect(taskBody?.error?.code).toBe("unsupported_task_id");

      const issueRes = await fetch(`${server.url}/v1/commands/issue/priority`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "owner/repo", issueNumber: 123, priority: "p1" }),
      });
      expect(issueRes.status).toBe(503);
      const issueBody = await issueRes.json();
      expect(issueBody?.error?.code).toBe("github_transient");
      expect(issueBody?.error?.message).toBe("temporary outage");
    } finally {
      server.stop();
    }
  });
});

import type { ServerWebSocket } from "bun";

import { buildRalphEvent } from "./events";
import { type RalphEventBus } from "./event-bus";
import {
  matchAnyToken,
  parseBearerToken,
  parseProtocolToken,
  parseQueryToken,
  parseReplayLast,
  serializeEvent,
  serializeStateSnapshot,
  tokensMatch,
} from "./control-plane-core";
import { isControlPlaneHttpError } from "./control-plane-errors";
import { isIssueCommandName } from "./issue-commands";

export type ControlPlaneStateProvider<TSnapshot> = () => Promise<TSnapshot>;

export type ControlPlaneCommandHandlers = {
  pause: (params: { workerId?: string | null; reason?: string | null; checkpoint?: string | null }) => Promise<void> | void;
  resume: (params: { workerId?: string | null; reason?: string | null }) => Promise<void> | void;
  enqueueMessage: (params: { workerId?: string | null; sessionId?: string | null; text: string }) =>
    | Promise<{ id?: string } | void>
    | { id?: string }
    | void;
  interruptMessage?: (params: { workerId?: string | null; sessionId?: string | null; text: string }) =>
    | Promise<{ id?: string } | void>
    | { id?: string }
    | void;
  setTaskPriority: (params: { taskId: string; priority: string }) => Promise<void> | void;
  setTaskStatus: (params: { taskId: string; status: string }) => Promise<void> | void;
  setIssuePriority?: (params: { repo: string; issueNumber: number; priority: string }) => Promise<void> | void;
  enqueueIssueCommand?: (params: { repo: string; issueNumber: number; cmd: "queue" | "pause" | "stop" | "satisfy" }) =>
    | Promise<void>
    | void;
};

export class ControlPlaneCommandError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ControlPlaneServerOptions<TSnapshot> = {
  bus: RalphEventBus;
  getStateSnapshot: ControlPlaneStateProvider<TSnapshot>;
  token: string;
  host: string;
  port: number;
  exposeRawOpencodeEvents?: boolean;
  replayLastDefault?: number;
  replayLastMax?: number;
  commands?: ControlPlaneCommandHandlers;
};

export type ControlPlaneServer = {
  url: string;
  host: string;
  port: number;
  stop: () => void;
};

type WebSocketData = {
  replayLast: number;
  exposeRawOpencodeEvents: boolean;
  unsubscribe?: () => void;
};

const LOG_PREFIX = "[ralph:control-plane]";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonResponseRaw(status: number, body: string, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(body, { status, headers });
}

function jsonError(status: number, code: string, message: string, extraHeaders?: HeadersInit): Response {
  return jsonResponse(status, { error: { code, message } }, extraHeaders);
}

async function parseJsonBody(request: Request): Promise<{ ok: true; value: any } | { ok: false; error: Response }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, error: jsonError(415, "unsupported_media_type", "Expected application/json") };
  }

  try {
    const value = await request.json();
    return { ok: true, value };
  } catch {
    return { ok: false, error: jsonError(400, "bad_request", "Invalid JSON") };
  }
}

function requireBearerAuth(token: string, request: Request): Response | null {
  const auth = parseBearerToken(request.headers.get("authorization"));
  if (!tokensMatch(token, auth)) {
    return jsonError(401, "unauthorized", "Missing or invalid token", { "WWW-Authenticate": "Bearer" });
  }
  return null;
}

function publishInternalError(bus: RalphEventBus, message: string): void {
  bus.publish(
    buildRalphEvent({
      type: "error",
      level: "error",
      data: { message },
    })
  );
}

function parseIssueNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function startControlPlaneServer<TSnapshot>(
  options: ControlPlaneServerOptions<TSnapshot>
): ControlPlaneServer {
  const replayDefault = Math.max(0, Math.floor(options.replayLastDefault ?? 50));
  const replayMax = Math.max(0, Math.floor(options.replayLastMax ?? 250));
  const token = options.token;

  const server = Bun.serve<WebSocketData>({
    hostname: options.host,
    port: options.port,
    async fetch(request: Request, serverInstance: Bun.Server<WebSocketData>) {
      const url = new URL(request.url);
      const path = url.pathname;

      try {
        if (path === "/v1/events") {
          const authHeader = request.headers.get("authorization");
          const headerToken = parseBearerToken(authHeader);
          const protocolHeader = request.headers.get("sec-websocket-protocol");
          const { token: protocolToken, protocol } = parseProtocolToken(protocolHeader);
          const queryToken = parseQueryToken(url);

          const auth = matchAnyToken({
            expected: token,
            headerToken,
            protocolToken,
            protocol,
            queryToken,
          });
          if (!auth.authorized) {
            return jsonError(
              401,
              "unauthorized",
              "Missing or invalid token",
              { "WWW-Authenticate": "Bearer" }
            );
          }

          const replayLast = parseReplayLast(url.searchParams.get("replayLast"), replayDefault, replayMax);
          const upgraded = serverInstance.upgrade(request, {
            data: {
              replayLast,
              exposeRawOpencodeEvents: options.exposeRawOpencodeEvents ?? false,
            },
            headers: auth.protocol ? { "Sec-WebSocket-Protocol": auth.protocol } : undefined,
          });

          if (upgraded) return;
          return jsonError(400, "bad_request", "WebSocket upgrade required");
        }

        if (path === "/v1/state") {
          if (request.method !== "GET") return jsonError(405, "method_not_allowed", "Method not allowed");
          const authError = requireBearerAuth(token, request);
          if (authError) return authError;

          return options
            .getStateSnapshot()
            .then((snapshot) => jsonResponseRaw(200, serializeStateSnapshot(snapshot)))
            .catch((error: any) => {
              const message = error?.message ?? String(error);
              console.warn(`${LOG_PREFIX} Failed to build state snapshot: ${message}`);
              publishInternalError(options.bus, `Control plane snapshot failed: ${message}`);
              return jsonError(500, "internal", "Failed to build snapshot");
            });
        }

        if (path === "/healthz") {
          if (request.method !== "GET") return jsonError(405, "method_not_allowed", "Method not allowed");
          const authError = requireBearerAuth(token, request);
          if (authError) return authError;
          return jsonResponse(200, { ok: true });
        }

        if (path.startsWith("/v1/commands/")) {
          const authError = requireBearerAuth(token, request);
          if (authError) return authError;
          if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Method not allowed");

          const commands = options.commands;
          if (!commands) {
            return jsonError(501, "not_implemented", "Control commands are not enabled");
          }

          if (path === "/v1/commands/pause") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const workerId = typeof body?.workerId === "string" ? body.workerId : null;
            const reason = typeof body?.reason === "string" ? body.reason : null;
            const checkpoint = typeof body?.checkpoint === "string" ? body.checkpoint : null;

            await commands.pause({ workerId, reason, checkpoint });
            return jsonResponse(200, { ok: true });
          }

          if (path === "/v1/commands/resume") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const workerId = typeof body?.workerId === "string" ? body.workerId : null;
            const reason = typeof body?.reason === "string" ? body.reason : null;

            await commands.resume({ workerId, reason });
            return jsonResponse(200, { ok: true });
          }

          if (path === "/v1/commands/message/enqueue") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const text = typeof body?.text === "string" ? body.text : "";
            if (!text.trim()) return jsonError(400, "bad_request", "Missing text");

            const workerId = typeof body?.workerId === "string" ? body.workerId : null;
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
            const result = await commands.enqueueMessage({ workerId, sessionId, text });
            return jsonResponse(200, { ok: true, ...(result && typeof result === "object" ? result : {}) });
          }

          if (path === "/v1/commands/message/interrupt") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const text = typeof body?.text === "string" ? body.text : "";
            if (!text.trim()) return jsonError(400, "bad_request", "Missing text");

            if (!commands.interruptMessage) {
              return jsonError(501, "not_implemented", "Interrupt messaging is not enabled");
            }

            const workerId = typeof body?.workerId === "string" ? body.workerId : null;
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
            const result = await commands.interruptMessage({ workerId, sessionId, text });
            return jsonResponse(200, { ok: true, ...(result && typeof result === "object" ? result : {}) });
          }

          if (path === "/v1/commands/task/priority") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const taskId = typeof body?.taskId === "string" ? body.taskId : "";
            const priority = typeof body?.priority === "string" ? body.priority : "";
            if (!taskId.trim()) return jsonError(400, "bad_request", "Missing taskId");
            if (!priority.trim()) return jsonError(400, "bad_request", "Missing priority");

            await commands.setTaskPriority({ taskId, priority });
            return jsonResponse(200, { ok: true });
          }

          if (path === "/v1/commands/task/status") {
            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const taskId = typeof body?.taskId === "string" ? body.taskId : "";
            const status = typeof body?.status === "string" ? body.status : "";
            if (!taskId.trim()) return jsonError(400, "bad_request", "Missing taskId");
            if (!status.trim()) return jsonError(400, "bad_request", "Missing status");

            await commands.setTaskStatus({ taskId, status });
            return jsonResponse(200, { ok: true });
          }

          if (path === "/v1/commands/issue/priority") {
            if (!commands.setIssuePriority) {
              return jsonError(501, "not_implemented", "Issue priority commands are not enabled");
            }

            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const repo = typeof body?.repo === "string" ? body.repo : "";
            const issueNumber = parseIssueNumber(body?.issueNumber);
            const priority = typeof body?.priority === "string" ? body.priority : "";
            if (!repo.trim()) return jsonError(400, "bad_request", "Missing repo");
            if (issueNumber === null) return jsonError(400, "bad_request", "Missing or invalid issueNumber");
            if (!priority.trim()) return jsonError(400, "bad_request", "Missing priority");

            await commands.setIssuePriority({ repo, issueNumber, priority });
            return jsonResponse(202, { ok: true, accepted: true });
          }

          if (path === "/v1/commands/issue/cmd") {
            if (!commands.enqueueIssueCommand) {
              return jsonError(501, "not_implemented", "Issue command queueing is not enabled");
            }

            const parsed = await parseJsonBody(request);
            if (!parsed.ok) return parsed.error;
            const body = parsed.value;

            const repo = typeof body?.repo === "string" ? body.repo : "";
            const issueNumber = parseIssueNumber(body?.issueNumber);
            const cmdRaw = typeof body?.cmd === "string" ? body.cmd : "";
            if (!repo.trim()) return jsonError(400, "bad_request", "Missing repo");
            if (issueNumber === null) return jsonError(400, "bad_request", "Missing or invalid issueNumber");
            if (!isIssueCommandName(cmdRaw)) {
              return jsonError(400, "bad_request", "Invalid cmd (expected queue|pause|stop|satisfy)");
            }

            await commands.enqueueIssueCommand({ repo, issueNumber, cmd: cmdRaw });
            return jsonResponse(202, { ok: true, accepted: true });
          }

          return jsonError(404, "not_found", "Not found");
        }

        return jsonError(404, "not_found", "Not found");
      } catch (error: any) {
        if (error instanceof ControlPlaneCommandError) {
          return jsonError(error.status, error.code, error.message);
        }

        if (isControlPlaneHttpError(error)) {
          return jsonError(error.status, error.code, error.message);
        }
        const message = error?.message ?? String(error);
        console.warn(`${LOG_PREFIX} Request failed: ${message}`);
        publishInternalError(options.bus, `Control plane request failed: ${message}`);
        return jsonError(500, "internal", "Internal server error");
      }
    },
    websocket: {
      open(ws: ServerWebSocket<WebSocketData>) {
        const data = ws.data;
        const replayLast = Math.min(data.replayLast, replayMax);
        const exposeRawOpencodeEvents = data.exposeRawOpencodeEvents;
        const unsubscribe = options.bus.subscribe((event) => {
          const payload = serializeEvent(event, exposeRawOpencodeEvents);
          if (!payload) return;
          try {
            ws.send(payload);
          } catch {
            // ignore
          }
        }, { replayLast });
        ws.data = { ...data, unsubscribe };
      },
      message() {
        // Control plane is server-push only.
      },
      close(ws: ServerWebSocket<WebSocketData>) {
        ws.data.unsubscribe?.();
      },
    },
  });

  return {
    host: options.host,
    port: server.port ?? options.port,
    url: `http://${options.host}:${server.port ?? options.port}`,
    stop: () => {
      server.stop(true);
    },
  };
}

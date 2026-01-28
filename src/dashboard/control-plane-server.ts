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

export type ControlPlaneStateProvider<TSnapshot> = () => Promise<TSnapshot>;

export type ControlPlaneServerOptions<TSnapshot> = {
  bus: RalphEventBus;
  getStateSnapshot: ControlPlaneStateProvider<TSnapshot>;
  token: string;
  host: string;
  port: number;
  exposeRawOpencodeEvents?: boolean;
  replayLastDefault?: number;
  replayLastMax?: number;
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

function publishInternalError(bus: RalphEventBus, message: string): void {
  bus.publish(
    buildRalphEvent({
      type: "error",
      level: "error",
      data: { message },
    })
  );
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
    fetch(request: Request, serverInstance: Bun.Server<WebSocketData>) {
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
          const auth = parseBearerToken(request.headers.get("authorization"));
          if (!tokensMatch(token, auth)) {
            return jsonError(401, "unauthorized", "Missing or invalid token", { "WWW-Authenticate": "Bearer" });
          }

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
          const auth = parseBearerToken(request.headers.get("authorization"));
          if (!tokensMatch(token, auth)) {
            return jsonError(401, "unauthorized", "Missing or invalid token", { "WWW-Authenticate": "Bearer" });
          }
          return jsonResponse(200, { ok: true });
        }

        return jsonError(404, "not_found", "Not found");
      } catch (error: any) {
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

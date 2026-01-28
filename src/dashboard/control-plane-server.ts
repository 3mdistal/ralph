import { timingSafeEqual } from "crypto";
import type { ServerWebSocket } from "bun";

import { buildRalphEvent, safeJsonStringifyRalphEvent, type RalphEvent } from "./events";
import { type RalphEventBus } from "./event-bus";
import { redactSensitiveText } from "../redaction";

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
const AUTH_PREFIX = "Bearer ";
const WS_PROTOCOL_PREFIX = "ralph.bearer.";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonError(status: number, code: string, message: string, extraHeaders?: HeadersInit): Response {
  return jsonResponse(status, { error: { code, message } }, extraHeaders);
}

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  if (!header.toLowerCase().startsWith(AUTH_PREFIX.toLowerCase())) return null;
  const token = header.slice(AUTH_PREFIX.length).trim();
  return token ? token : null;
}

function parseProtocolToken(header: string | null): { token: string | null; protocol: string | null } {
  if (!header) return { token: null, protocol: null };
  const protocols = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const protocol of protocols) {
    if (protocol.startsWith(WS_PROTOCOL_PREFIX)) {
      const token = protocol.slice(WS_PROTOCOL_PREFIX.length).trim();
      if (token) return { token, protocol };
    }
  }
  return { token: null, protocol: null };
}

function parseQueryToken(url: URL): string | null {
  const token = url.searchParams.get("access_token")?.trim();
  return token ? token : null;
}

function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const expectedBuf = encoder.encode(expected);
  const providedBuf = encoder.encode(provided);
  return timingSafeEqual(expectedBuf, providedBuf);
}

function parseReplayLast(raw: string | null, fallback: number, max: number): number {
  if (!raw) return Math.min(Math.max(0, fallback), max);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Math.min(Math.max(0, fallback), max);
  const value = Math.floor(parsed);
  if (value < 0) return 0;
  return Math.min(value, max);
}

function serializeEvent(event: RalphEvent, exposeRawOpencodeEvents: boolean): string | null {
  if (!exposeRawOpencodeEvents && event.type === "log.opencode.event") return null;
  const json = safeJsonStringifyRalphEvent(event);
  return redactSensitiveText(json);
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

          const providedToken = headerToken ?? protocolToken ?? queryToken;
          if (!tokensMatch(token, providedToken)) {
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
            headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
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
            .then((snapshot) => jsonResponse(200, snapshot))
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
      close(ws: ServerWebSocket<WebSocketData>) {
        ws.data.unsubscribe?.();
      },
    },
  });

  return {
    host: options.host,
    port: server.port,
    url: `http://${options.host}:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
}

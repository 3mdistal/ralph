import { assertRalphEvent, type RalphEvent } from "../events";
import type { ControlPlaneStateV1 } from "../control-plane-state";
import type { ConnectionStatus } from "./core";

export type DashboardApiErrorCode = "unauthorized" | "network" | "invalid_response";

export class DashboardApiError extends Error {
  readonly code: DashboardApiErrorCode;

  constructor(code: DashboardApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type EventStreamHandlers = {
  onEvent: (event: RalphEvent, meta: { receivedAt: number; eventTsMs: number | null }) => void;
  onStatus: (status: ConnectionStatus, message?: string) => void;
  onError?: (error: Error) => void;
};

export type ConnectOptions = {
  baseUrl: string;
  token: string;
  replayLast: number;
  handlers: EventStreamHandlers;
};

export async function fetchControlPlaneState(baseUrl: string, token: string): Promise<ControlPlaneStateV1> {
  const url = new URL("/v1/state", baseUrl);
  let response: Response;

  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error: any) {
    throw new DashboardApiError("network", error?.message ?? "Failed to fetch control plane state");
  }

  if (response.status === 401) {
    throw new DashboardApiError("unauthorized", "Missing or invalid token");
  }

  if (!response.ok) {
    throw new DashboardApiError(
      "invalid_response",
      `Unexpected response (${response.status} ${response.statusText})`
    );
  }

  try {
    return (await response.json()) as ControlPlaneStateV1;
  } catch (error: any) {
    throw new DashboardApiError("invalid_response", error?.message ?? "Invalid JSON response");
  }
}

function toWebSocketUrl(baseUrl: string, replayLast: number, token: string, useQueryToken: boolean): string {
  const url = new URL("/v1/events", baseUrl);
  url.searchParams.set("replayLast", String(replayLast));
  if (useQueryToken) url.searchParams.set("access_token", token);
  if (url.protocol === "https:") url.protocol = "wss:";
  else url.protocol = "ws:";
  return url.toString();
}

function buildProtocol(token: string): string {
  return `ralph.bearer.${token}`;
}

export function connectControlPlaneEvents(options: ConnectOptions): { close: () => void } {
  const { baseUrl, token, replayLast, handlers } = options;
  let socket: WebSocket | null = null;
  let opened = false;
  let attemptedFallback = false;

  const openSocket = (useQueryToken: boolean): void => {
    const url = toWebSocketUrl(baseUrl, replayLast, token, useQueryToken);
    handlers.onStatus("connecting");
    if (useQueryToken) {
      socket = new WebSocket(url);
    } else {
      socket = new WebSocket(url, [buildProtocol(token)]);
    }

    if (!socket) return;

    socket.addEventListener("open", () => {
      opened = true;
      handlers.onStatus("connected");
    });

    socket.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
        assertRalphEvent(parsed, "dashboard.client.event");
      } catch (error: any) {
        handlers.onError?.(error);
        return;
      }

      const ralphEvent = parsed as RalphEvent;
      const parsedTs = Date.parse(ralphEvent.ts);
      const eventTsMs = Number.isFinite(parsedTs) ? parsedTs : null;
      handlers.onEvent(ralphEvent, { receivedAt, eventTsMs });
    });

    socket.addEventListener("close", (event) => {
      if (!opened && !useQueryToken && !attemptedFallback) {
        attemptedFallback = true;
        openSocket(true);
        return;
      }
      handlers.onStatus("disconnected", `WebSocket closed (${event.code})`);
    });

    socket.addEventListener("error", () => {
      if (!opened && !useQueryToken && !attemptedFallback) {
        attemptedFallback = true;
        try {
          socket?.close();
        } catch {
          // ignore
        }
        openSocket(true);
        return;
      }
      handlers.onStatus("disconnected", "WebSocket error");
    });
  };

  openSocket(false);

  return {
    close: () => {
      try {
        socket?.close();
      } catch {
        // ignore
      }
    },
  };
}

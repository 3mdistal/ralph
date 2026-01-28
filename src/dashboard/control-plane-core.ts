import { timingSafeEqual } from "crypto";

import { redactSensitiveText } from "../redaction";
import { safeJsonStringifyRalphEvent, type RalphEvent } from "./events";

const AUTH_PREFIX = "Bearer ";
const WS_PROTOCOL_PREFIX = "ralph.bearer.";

export type ParsedProtocolToken = { token: string | null; protocol: string | null };
export type TokenMatchResult = { authorized: boolean; protocol: string | null };

export function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  if (!header.toLowerCase().startsWith(AUTH_PREFIX.toLowerCase())) return null;
  const token = header.slice(AUTH_PREFIX.length).trim();
  return token ? token : null;
}

export function parseProtocolToken(header: string | null): ParsedProtocolToken {
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

export function parseQueryToken(url: URL): string | null {
  const token = url.searchParams.get("access_token")?.trim();
  return token ? token : null;
}

export function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const expectedBuf = encoder.encode(expected);
  const providedBuf = encoder.encode(provided);
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function matchAnyToken(args: {
  expected: string;
  headerToken: string | null;
  protocolToken: string | null;
  protocol: string | null;
  queryToken: string | null;
}): TokenMatchResult {
  const headerOk = tokensMatch(args.expected, args.headerToken);
  const protocolOk = tokensMatch(args.expected, args.protocolToken);
  const queryOk = tokensMatch(args.expected, args.queryToken);
  return {
    authorized: headerOk || protocolOk || queryOk,
    protocol: protocolOk ? args.protocol : null,
  };
}

export function parseReplayLast(raw: string | null, fallback: number, max: number): number {
  if (!raw) return Math.min(Math.max(0, fallback), max);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Math.min(Math.max(0, fallback), max);
  const value = Math.floor(parsed);
  if (value < 0) return 0;
  return Math.min(value, max);
}

export function serializeEvent(event: RalphEvent, exposeRawOpencodeEvents: boolean): string | null {
  if (!exposeRawOpencodeEvents && event.type === "log.opencode.event") return null;
  const json = safeJsonStringifyRalphEvent(event);
  return redactSensitiveText(json);
}

export function serializeStateSnapshot(snapshot: unknown): string {
  const json = JSON.stringify(snapshot);
  return redactSensitiveText(json);
}

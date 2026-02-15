export type OpencodeTransportMode = "cli" | "sdk" | "sdk-preferred";

export type OpencodeTransportFailureCode =
  | "sdk-module-unavailable"
  | "sdk-client-shape"
  | "server-start-failed"
  | "server-health-failed"
  | "sdk-request-failed";

export type OpencodeTransportFailure = {
  code: OpencodeTransportFailureCode;
  message: string;
};

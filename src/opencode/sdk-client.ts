import type { OpencodeTransportFailure } from "./transport-types";

type SdkFactoryModule = {
  createOpencodeClient?: (options: { baseUrl: string }) => unknown;
};

export async function createSdkClient(baseUrl: string): Promise<unknown> {
  let mod: SdkFactoryModule;
  try {
    mod = (await import("@opencode-ai/sdk")) as SdkFactoryModule;
  } catch (error: any) {
    const reason: OpencodeTransportFailure = {
      code: "sdk-module-unavailable",
      message: `Failed to load @opencode-ai/sdk: ${String(error?.message ?? error)}`,
    };
    throw reason;
  }

  const factory = mod.createOpencodeClient;
  if (typeof factory !== "function") {
    const reason: OpencodeTransportFailure = {
      code: "sdk-client-shape",
      message: "@opencode-ai/sdk does not export createOpencodeClient",
    };
    throw reason;
  }

  return factory({ baseUrl });
}

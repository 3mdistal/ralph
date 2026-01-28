import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { __setGitHubAuthDepsForTests, __testOnlyFetchAuthenticatedAppSlug } from "../github-app-auth";

describe("github-app-auth app slug", () => {
  const prior = { ...process.env };

  beforeEach(() => {
    __setGitHubAuthDepsForTests({
      readFile: async () => "dummy-key",
      createSign: (() => {
        return {
          update: () => void 0,
          end: () => void 0,
          sign: () => new Uint8Array([1, 2, 3]),
        } as any;
      }) as any,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
        expect(url).toBe("https://api.github.com/app");
        const auth = (init?.headers as any)?.Authorization ?? (init?.headers as any)?.authorization;
        expect(String(auth ?? "").startsWith("Bearer ")).toBe(true);
        return new Response(JSON.stringify({ slug: "teenylilralph" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  });

  afterEach(() => {
    process.env = prior;
  });

  test("fetches slug via /app", async () => {
    const slug = await __testOnlyFetchAuthenticatedAppSlug({ appId: 123, privateKeyPath: "/tmp/key.pem" });
    expect(slug).toBe("teenylilralph");
  });
});

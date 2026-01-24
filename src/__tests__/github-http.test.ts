import { describe, expect, test } from "bun:test";

import { fetchJson, parseLinkHeader } from "../github/http";

describe("github http helpers", () => {
  test("parseLinkHeader handles multiple rels with extra params", () => {
    const input =
      '<https://api.github.com/repos?page=2>; rel="next", <https://api.github.com/repos?page=5>; type="application/json"; rel="last", nope';

    expect(parseLinkHeader(input)).toEqual({
      next: "https://api.github.com/repos?page=2",
      last: "https://api.github.com/repos?page=5",
    });
  });

  test("fetchJson returns headers on error", async () => {
    const fetchImpl = async () =>
      new Response("nope", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "123",
        },
      });

    const result = await fetchJson(fetchImpl, "https://example.com", { method: "GET" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body).toBe("nope");
      expect(result.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(result.headers.get("x-ratelimit-reset")).toBe("123");
    }
  });
});

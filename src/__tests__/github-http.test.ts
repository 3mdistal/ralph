import { fetchJson, parseLinkHeader } from "../github/http";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("github http helpers", () => {
  test("parseLinkHeader handles null and basic links", () => {
    expect(parseLinkHeader(null)).toEqual({});

    const linkHeader =
      '<https://api.github.com/repos/3mdistal/ralph/issues?page=2>; rel="next", <https://api.github.com/repos/3mdistal/ralph/issues?page=4>; rel="last"';
    expect(parseLinkHeader(linkHeader)).toEqual({
      next: "https://api.github.com/repos/3mdistal/ralph/issues?page=2",
      last: "https://api.github.com/repos/3mdistal/ralph/issues?page=4",
    });
  });

  test("parseLinkHeader tolerates whitespace and extra params", () => {
    const linkHeader =
      ' <https://api.github.com/repos/3mdistal/ralph/issues?page=3>; rel="next"; foo="bar", nope, <https://api.github.com/repos/3mdistal/ralph/issues?page=5>; rel="last"';
    expect(parseLinkHeader(linkHeader)).toEqual({
      next: "https://api.github.com/repos/3mdistal/ralph/issues?page=3",
      last: "https://api.github.com/repos/3mdistal/ralph/issues?page=5",
    });
  });

  test("fetchJson returns data and headers on success", async () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const fetchMock: FetchLike = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers });

    const result = await fetchJson<{ ok: boolean }>(fetchMock, "https://api.github.com/test", {
      method: "GET",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ok).toBe(true);
      expect(result.headers.get("Content-Type")).toBe("application/json");
    }
  });

  test("fetchJson returns status, body, and headers on error", async () => {
    const headers = new Headers({ "x-request-id": "abc" });
    const fetchMock: FetchLike = async () => new Response("nope", { status: 500, headers });

    const result = await fetchJson(fetchMock, "https://api.github.com/test", { method: "GET" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.body).toBe("nope");
      expect(result.headers.get("x-request-id")).toBe("abc");
    }
  });

  test("fetchJson uses empty body on text failure", async () => {
    const headers = new Headers({ "x-request-id": "def" });
    const response = {
      ok: false,
      status: 502,
      headers,
      text: async () => {
        throw new Error("boom");
      },
    };

    const fetchMock: FetchLike = async () => response as unknown as Response;

    const result = await fetchJson(fetchMock, "https://api.github.com/test", { method: "GET" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.body).toBe("");
      expect(result.headers.get("x-request-id")).toBe("def");
    }
  });
});

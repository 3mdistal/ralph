export type FetchJsonResult<T> =
  | { ok: true; data: T; headers: Headers }
  | { ok: false; status: number; body: string; headers: Headers };

export async function fetchJson<T>(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string | URL,
  init: RequestInit
): Promise<FetchJsonResult<T>> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, body: text, headers: res.headers };
  }

  const data = (await res.json()) as T;
  return { ok: true, data, headers: res.headers };
}

export function parseLinkHeader(link: string | null): Record<string, string> {
  if (!link) return {};

  const out: Record<string, string> = {};
  const parts = link.split(/,\s*(?=<)/);
  for (const part of parts) {
    const urlMatch = part.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    const relMatch = part.match(/\brel="([^"]+)"/);
    if (!relMatch) continue;
    const [, url] = urlMatch;
    const [, rel] = relMatch;
    out[rel] = url;
  }
  return out;
}

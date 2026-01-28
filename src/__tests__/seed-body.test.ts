import { describe, expect, test } from "bun:test";
import {
  buildManagedRegion,
  formatSeedMarker,
  parseSeedMarker,
  replaceManagedRegion,
  MANAGED_BEGIN,
  MANAGED_END,
} from "../sandbox/seed-body";

describe("seed body helpers", () => {
  test("parseSeedMarker extracts marker and slug", () => {
    const body = "<!-- ralph-seed-suite:v1 slug=demo -->\nhello";
    expect(parseSeedMarker(body)).toEqual({ marker: "ralph-seed-suite:v1", slug: "demo" });
  });

  test("replaceManagedRegion injects marker and region", () => {
    const marker = formatSeedMarker("ralph-seed-suite:v1", "demo");
    const region = buildManagedRegion(["line-1", "line-2"]);
    const updated = replaceManagedRegion({ body: "Existing text", markerLine: marker, region });
    expect(updated).toContain(marker);
    expect(updated).toContain(MANAGED_BEGIN);
    expect(updated).toContain("line-1");
    expect(updated).toContain(MANAGED_END);
  });

  test("replaceManagedRegion overwrites existing managed region", () => {
    const marker = formatSeedMarker("ralph-seed-suite:v1", "demo");
    const prior = [marker, MANAGED_BEGIN, "old", MANAGED_END, "tail"].join("\n");
    const region = buildManagedRegion(["new"]);
    const updated = replaceManagedRegion({ body: prior, markerLine: marker, region });
    expect(updated).toContain("new");
    expect(updated).not.toContain("old");
  });
});

import { describe, expect, test } from "bun:test";

import { __streamSessionForTests } from "../session";

describe("OpenCode JSON stream handling", () => {

  test("ignores malformed JSON lines and yields valid events", async () => {
    const spawn = (() => {
      const stdout = (async function* () {
        yield Buffer.from('{"a":1}\n');
        yield Buffer.from("{bad json\n{\"b\":2}\n");
        yield Buffer.from('{"c":');
        yield Buffer.from('3}\n');
      })();

      return { stdout } as any;
    }) as any;

    const events: any[] = [];
    for await (const event of __streamSessionForTests("/tmp", "hello", { __testOverrides: { spawn } } as any)) {
      events.push(event);
    }

    expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("ignores truncated final JSON fragment", async () => {
    const spawn = (() => {
      const stdout = (async function* () {
        yield Buffer.from('{"a":1}\n{\"b\":2}\n{\"c\":');
      })();

      return { stdout } as any;
    }) as any;

    const events: any[] = [];
    for await (const event of __streamSessionForTests("/tmp", "hello", { __testOverrides: { spawn } } as any)) {
      events.push(event);
    }

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { __resetSpawnForTests, __setSpawnForTests, __streamSessionForTests } from "../session";

describe("OpenCode JSON stream handling", () => {
  afterEach(() => {
    __resetSpawnForTests();
  });

  test("ignores malformed JSON lines and yields valid events", async () => {
    __setSpawnForTests(() => {
      const stdout = (async function* () {
        yield Buffer.from('{"a":1}\n');
        yield Buffer.from("{bad json\n{\"b\":2}\n");
        yield Buffer.from('{"c":');
        yield Buffer.from('3}\n');
      })();

      return { stdout } as any;
    });

    const events: any[] = [];
    for await (const event of __streamSessionForTests("/tmp", "hello")) {
      events.push(event);
    }

    expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("ignores truncated final JSON fragment", async () => {
    __setSpawnForTests(() => {
      const stdout = (async function* () {
        yield Buffer.from('{"a":1}\n{\"b\":2}\n{\"c\":');
      })();

      return { stdout } as any;
    });

    const events: any[] = [];
    for await (const event of __streamSessionForTests("/tmp", "hello")) {
      events.push(event);
    }

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

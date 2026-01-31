import { createReadStream, existsSync } from "fs";

export type SessionEventLinesResult = {
  lines: string[];
  byteCount: number;
  tooLarge: boolean;
  timedOut: boolean;
  missing: boolean;
  error?: string;
};

export async function readSessionEventLines(params: {
  path: string;
  maxBytes: number;
  timeBudgetMs: number;
}): Promise<SessionEventLinesResult> {
  const result: SessionEventLinesResult = {
    lines: [],
    byteCount: 0,
    tooLarge: false,
    timedOut: false,
    missing: false,
  };

  if (!existsSync(params.path)) {
    result.missing = true;
    return result;
  }

  const start = Date.now();

  return await new Promise<SessionEventLinesResult>((resolve) => {
    let buffer = "";
    let resolved = false;
    const stream = createReadStream(params.path, { encoding: "utf8" });

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      if (buffer.trim()) result.lines.push(buffer);
      resolve(result);
    };

    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      result.byteCount += Buffer.byteLength(text, "utf8");
      if (params.maxBytes > 0 && result.byteCount > params.maxBytes) {
        result.tooLarge = true;
        stream.destroy();
        return;
      }

      if (params.timeBudgetMs > 0 && Date.now() - start > params.timeBudgetMs) {
        result.timedOut = true;
        stream.destroy();
        return;
      }

      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        result.lines.push(line);
      }
    });

    stream.on("error", (err: unknown) => {
      const message = typeof err === "object" && err && "message" in err ? String((err as { message?: unknown }).message) : String(err);
      result.error = message;
      finalize();
    });

    stream.on("close", finalize);
    stream.on("end", finalize);
  });
}

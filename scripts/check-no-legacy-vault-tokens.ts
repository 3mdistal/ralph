const blockedTerms = [
  ["b", "wrb"].join(""),
  ["b", "wrb", "Vault"].join(""),
];

const excludedPaths = new Set([".ralph/plan.md"]);

function listTrackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(stderr || "git ls-files failed");
  }

  const stdout = new TextDecoder().decode(result.stdout);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasNulByte(bytes: Uint8Array): boolean {
  for (const value of bytes) {
    if (value === 0) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const hits: string[] = [];

  for (const path of listTrackedFiles()) {
    if (excludedPaths.has(path)) continue;

    const file = Bun.file(path);
    if (!(await file.exists())) continue;

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hasNulByte(bytes)) continue;

    const content = new TextDecoder().decode(bytes);
    if (blockedTerms.some((term) => content.includes(term))) {
      hits.push(path);
    }
  }

  if (hits.length === 0) return;

  console.error("Legacy vault token check failed in tracked files:");
  for (const path of hits) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

await main();

export {};

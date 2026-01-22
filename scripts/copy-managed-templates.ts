import { mkdirSync } from "fs";
import { cp } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

const sourceDir = join(repoRoot, "src", "opencode-managed-config", "templates");
const destDir = join(repoRoot, "dist", "opencode-managed-config", "templates");

mkdirSync(dirname(destDir), { recursive: true });
await cp(sourceDir, destDir, { recursive: true });

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";

import { loadConfig } from "./config";
import { getRalphOpencodeConfigDir } from "./paths";

const TEMPLATE_DIR = fileURLToPath(new URL("./opencode-managed-config/templates", import.meta.url));

type ManagedConfigFile = {
  path: string;
  contents: string;
};

export type ManagedConfigManifest = {
  configDir: string;
  files: ManagedConfigFile[];
};

function readTemplate(relativePath: string): string {
  const absolutePath = join(TEMPLATE_DIR, relativePath);
  return readFileSync(absolutePath, "utf8");
}

function ensureDir(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`[ralph] Refusing to write managed OpenCode config into symlink: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`[ralph] Managed OpenCode config path is not a directory: ${path}`);
    }
    return;
  }

  mkdirSync(path, { recursive: true });
}

function writeFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, path);
}

export function resolveManagedOpencodeConfigDir(): string {
  const envOverride = process.env.RALPH_OPENCODE_CONFIG_DIR?.trim();
  if (envOverride) {
    if (!isAbsolute(envOverride)) {
      throw new Error(
        `[ralph] RALPH_OPENCODE_CONFIG_DIR must be an absolute path (got ${JSON.stringify(envOverride)})`
      );
    }
    return envOverride;
  }

  const cfg = loadConfig();
  const configOverride = cfg.opencode?.managedConfigDir?.trim();
  if (configOverride) return configOverride;

  return getRalphOpencodeConfigDir();
}

export function getManagedOpencodeConfigManifest(configDir?: string): ManagedConfigManifest {
  const resolvedDir = configDir ?? resolveManagedOpencodeConfigDir();

  const files: ManagedConfigFile[] = [
    { path: join(resolvedDir, "opencode.json"), contents: readTemplate("opencode.json") },
    { path: join(resolvedDir, "agent", "build.md"), contents: readTemplate("agent/build.md") },
    { path: join(resolvedDir, "agent", "ralph-plan.md"), contents: readTemplate("agent/ralph-plan.md") },
    { path: join(resolvedDir, "agent", "product.md"), contents: readTemplate("agent/product.md") },
    { path: join(resolvedDir, "agent", "devex.md"), contents: readTemplate("agent/devex.md") },
  ];

  return { configDir: resolvedDir, files };
}

export function ensureManagedOpencodeConfigInstalled(configDir?: string): string {
  const manifest = getManagedOpencodeConfigManifest(configDir);
  const resolvedDir = manifest.configDir;

  if (!isAbsolute(resolvedDir)) {
    throw new Error(`[ralph] Managed OpenCode config dir must be absolute (got ${JSON.stringify(resolvedDir)})`);
  }

  ensureDir(resolvedDir);
  ensureDir(join(resolvedDir, "agent"));

  for (const file of manifest.files) {
    writeFileAtomic(file.path, file.contents);
  }

  return resolvedDir;
}

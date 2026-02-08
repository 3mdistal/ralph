import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { DoctorAction } from "./types";

function assertSafeRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("File is symlink");
  if (!stat.isFile()) throw new Error("Not a regular file");
}

function assertSafeDir(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Directory is symlink");
  if (!stat.isDirectory()) throw new Error("Not a directory");
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafeDir(dir);
}

function checkPreconditions(action: DoctorAction): void {
  if (!action.from || !action.preconditions) return;
  if (!existsSync(action.from)) throw new Error("Source missing before apply");
  assertSafeRegularFile(action.from);
  const stat = lstatSync(action.from);
  if (typeof action.preconditions.mtimeMs === "number" && stat.mtimeMs !== action.preconditions.mtimeMs) {
    throw new Error("Source file changed (mtime drift)");
  }
  if (typeof action.preconditions.size === "number" && stat.size !== action.preconditions.size) {
    throw new Error("Source file changed (size drift)");
  }
}

function resolveUniquePath(path: string): string {
  if (!existsSync(path)) return path;
  let attempt = 1;
  while (attempt <= 1000) {
    const candidate = `${path}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
  throw new Error(`Could not allocate unique path for ${path}`);
}

function applyAction(action: DoctorAction): DoctorAction {
  try {
    checkPreconditions(action);
    if (action.kind === "quarantine") {
      if (!action.from) throw new Error("Missing action.from");
      if (!existsSync(action.from)) return { ...action, ok: true };
      assertSafeRegularFile(action.from);
      const target = resolveUniquePath(action.to ?? `${action.from}.quarantine`);
      ensureParentDir(target);
      renameSync(action.from, target);
      return { ...action, to: target, ok: true };
    }

    if (action.kind === "write") {
      if (!action.to) throw new Error("Missing action.to");
      if (typeof action.payloadText !== "string") throw new Error("Missing action payload");
      ensureParentDir(action.to);
      const tempPath = `${action.to}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tempPath, action.payloadText, { mode: 0o600 });
      renameSync(tempPath, action.to);
      return { ...action, ok: true };
    }

    if (action.kind === "copy") {
      if (!action.from || !action.to) throw new Error("Missing copy paths");
      assertSafeRegularFile(action.from);
      ensureParentDir(action.to);
      const payload = readFileSync(action.from, "utf8");
      const tempPath = `${action.to}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tempPath, payload, { mode: 0o600 });
      renameSync(tempPath, action.to);
      return { ...action, ok: true };
    }

    if (action.kind === "move") {
      if (!action.from || !action.to) throw new Error("Missing move paths");
      assertSafeRegularFile(action.from);
      ensureParentDir(action.to);
      renameSync(action.from, action.to);
      return { ...action, ok: true };
    }

    return { ...action, ok: false, error: `Unsupported action kind: ${action.kind}` };
  } catch (error: any) {
    return { ...action, ok: false, error: error?.message ?? String(error) };
  }
}

export function executeDoctorPlan(actions: DoctorAction[]): { actions: DoctorAction[]; failures: number } {
  const applied = actions.map((action) => applyAction(action));
  const failures = applied.filter((action) => action.ok === false).length;
  return { actions: applied, failures };
}

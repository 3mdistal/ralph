import { getConfig } from "./config";
import { getInstallationToken } from "./github-app-auth";

export async function resolveGitHubToken(): Promise<string | null> {
  const config = getConfig();
  // When GitHub App auth is configured, prefer the installation token even if env vars exist.
  // Env tokens may be stale copies set for gh CLI calls.
  if (config.githubApp) {
    return await getInstallationToken();
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && token.trim()) return token.trim();

  return null;
}

import { getConfig, getProfile, getSandboxProfileConfig } from "./config";
import { getInstallationToken } from "./github-app-auth";

export async function resolveGitHubToken(): Promise<string | null> {
  const config = getConfig();
  const profile = getProfile();

  if (profile === "sandbox") {
    const sandbox = getSandboxProfileConfig();
    if (sandbox?.githubAuth?.githubApp) {
      return await getInstallationToken("sandbox");
    }

    const envVar = sandbox?.githubAuth?.tokenEnvVar;
    const token = envVar ? process.env[envVar] : undefined;
    if (token && token.trim()) return token.trim();
    return null;
  }

  // When GitHub App auth is configured, prefer the installation token even if env vars exist.
  // Env tokens may be stale copies set for gh CLI calls.
  if (config.githubApp) {
    return await getInstallationToken("prod");
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && token.trim()) return token.trim();

  return null;
}

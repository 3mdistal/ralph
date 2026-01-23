import { getConfig } from "./config";
import { getInstallationToken } from "./github-app-auth";

export async function resolveGitHubToken(): Promise<string | null> {
  const config = getConfig();
  if (config.githubApp) {
    return await getInstallationToken();
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && token.trim()) return token.trim();

  return null;
}

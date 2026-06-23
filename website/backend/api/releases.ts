import { api } from "encore.dev/api";
import { secret } from "encore.dev/config";
import {
  CacheCluster,
  StructKeyspace,
  expireInHours,
  expireInMinutes,
} from "encore.dev/storage/cache";

interface LatestReleaseResponse {
  source: string;
  version: string;
  branch: string;
  commit: string;
  repository: string;
  url: string;
  fetchedAt: string;
  changelog: ReleaseChange[];
}

interface ReleaseChange {
  commit: string;
  message: string;
  date: string;
  url: string;
}

interface GiteaContentResponse {
  content?: string;
  encoding?: string;
  download_url?: string;
}

interface GiteaCommitResponse {
  sha?: string;
  html_url?: string;
  url?: string;
  commit?: {
    message?: string;
    author?: { date?: string };
    committer?: { date?: string };
  };
}

interface PackageManifest {
  version?: string;
}

interface ReleaseNotification {
  commit: string;
  version: string;
  notifiedAt: string;
}

const giteaBaseUrl = cleanBaseUrl(process.env.NSTACK_RELEASE_GITEA_URL || "https://git.nik.technology");
const repositoryOwner = process.env.NSTACK_RELEASE_GITEA_OWNER || "angrymouse";
const repositoryName = process.env.NSTACK_RELEASE_GITEA_REPO || "nstack";
const releaseBranch = process.env.NSTACK_RELEASE_GITEA_BRANCH || "main";
const changelogLimit = positiveInteger(process.env.NSTACK_RELEASE_CHANGELOG_LIMIT, 8);
const cacheMinutes = positiveInteger(process.env.NSTACK_RELEASE_CACHE_MINUTES, 15);
const staleCacheHours = positiveInteger(process.env.NSTACK_RELEASE_STALE_CACHE_HOURS, 24);
const notificationCacheHours = positiveInteger(process.env.NSTACK_RELEASE_NOTIFICATION_CACHE_HOURS, 24 * 365);
const discordRequestTimeoutMs = positiveInteger(process.env.NSTACK_RELEASE_DISCORD_TIMEOUT_MS, 2000);
const discordWebhookUrl = secret("NSTACK_RELEASE_DISCORD_WEBHOOK_URL");

const releaseMetadataCache = new CacheCluster("release-metadata", {
  evictionPolicy: "allkeys-lru",
});
const freshReleases = new StructKeyspace<string, LatestReleaseResponse>(releaseMetadataCache, {
  keyPattern: "latest/:key",
  defaultExpiry: expireInMinutes(cacheMinutes),
});
const staleReleases = new StructKeyspace<string, LatestReleaseResponse>(releaseMetadataCache, {
  keyPattern: "stale/:key",
  defaultExpiry: expireInHours(staleCacheHours),
});
const notifiedReleases = new StructKeyspace<string, ReleaseNotification>(releaseMetadataCache, {
  keyPattern: "discord/:key",
  defaultExpiry: expireInHours(notificationCacheHours),
});

export const latest = api(
  { expose: true, method: "GET", path: "/releases/latest" },
  async (): Promise<LatestReleaseResponse> => cachedLatestRelease(),
);

async function cachedLatestRelease(): Promise<LatestReleaseResponse> {
  const key = releaseCacheKey();
  const cached = await readCache(freshReleases, key);
  if (cached) return cached;

  try {
    const release = await fetchLatestRelease();
    await writeCache(key, release);
    await notifyDiscordOnce(key, release);
    return release;
  } catch (error) {
    const stale = await readCache(staleReleases, key);
    if (stale) return stale;
    throw error;
  }
}

async function fetchLatestRelease(): Promise<LatestReleaseResponse> {
  const [manifest, commits] = await Promise.all([
    readPackageManifest(),
    readRecentCommits(),
  ]);
  const changelog = commits.map(normalizeCommit).filter((item): item is ReleaseChange => Boolean(item));
  return {
    source: "gitea",
    version: manifest.version || "0.0.0",
    branch: releaseBranch,
    commit: changelog[0]?.commit || "",
    repository: repositoryUrl(),
    url: repositoryUrl(),
    fetchedAt: new Date().toISOString(),
    changelog,
  };
}

async function readCache(
  cache: StructKeyspace<string, LatestReleaseResponse>,
  key: string,
): Promise<LatestReleaseResponse | undefined> {
  try {
    return await cache.get(key);
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, release: LatestReleaseResponse): Promise<void> {
  try {
    await Promise.all([
      freshReleases.set(key, release),
      staleReleases.set(key, release),
    ]);
  } catch {
    // Release checks can still return fresh Gitea data when cache storage is unavailable.
  }
}

async function readNotification(key: string): Promise<ReleaseNotification | undefined> {
  try {
    return await notifiedReleases.get(key);
  } catch {
    return undefined;
  }
}

async function writeNotification(key: string, release: LatestReleaseResponse): Promise<void> {
  try {
    await notifiedReleases.set(key, {
      commit: release.commit,
      version: release.version,
      notifiedAt: new Date().toISOString(),
    });
  } catch {
    // Cache failures should not break release metadata responses.
  }
}

async function notifyDiscordOnce(key: string, release: LatestReleaseResponse): Promise<void> {
  const webhookUrl = releaseDiscordWebhookUrl();
  if (!webhookUrl || !release.commit) return;

  const previous = await readNotification(key);
  if (previous?.commit === release.commit && previous.version === release.version) return;

  try {
    await postDiscordRelease(webhookUrl, release);
    await writeNotification(key, release);
  } catch {
    // Release metadata should stay available even when Discord is unavailable.
  }
}

async function postDiscordRelease(webhookUrl: string, release: LatestReleaseResponse): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordReleasePayload(release)),
    signal: AbortSignal.timeout(discordRequestTimeoutMs),
  });
  if (!response.ok) throw new Error(`Discord webhook request failed with HTTP ${response.status}.`);
}

function discordReleasePayload(release: LatestReleaseResponse): Record<string, unknown> {
  const latestChange = release.changelog[0];
  const description = release.changelog.slice(0, 5)
    .map((change) => discordChangeLine(change))
    .join("\n");
  return {
    username: "nstack releases",
    content: `nstack ${release.version} is available`,
    embeds: [
      {
        title: `nstack ${release.version}`,
        url: latestChange?.url || release.url,
        description: description || release.repository,
        fields: [
          { name: "Branch", value: release.branch || "main", inline: true },
          { name: "Commit", value: release.commit || "unknown", inline: true },
        ],
        timestamp: release.fetchedAt,
      },
    ],
  };
}

function discordChangeLine(change: ReleaseChange): string {
  const link = change.url ? `[${change.commit}](${change.url})` : change.commit;
  return `${link} ${change.message}`.slice(0, 240);
}

function releaseDiscordWebhookUrl(): string {
  return process.env.NSTACK_RELEASE_DISCORD_WEBHOOK_URL || discordWebhookUrl();
}

async function readPackageManifest(): Promise<PackageManifest> {
  const content = await giteaJson<GiteaContentResponse>(`/contents/package.json?ref=${encodeURIComponent(releaseBranch)}`);
  if (content.encoding === "base64" && content.content) {
    return JSON.parse(Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8"));
  }
  if (content.download_url) {
    const response = await fetch(content.download_url, { headers: requestHeaders() });
    if (!response.ok) throw new Error(`Gitea raw package.json request failed with HTTP ${response.status}.`);
    return await response.json();
  }
  throw new Error("Gitea package.json response did not include readable content.");
}

async function readRecentCommits(): Promise<GiteaCommitResponse[]> {
  return await giteaJson<GiteaCommitResponse[]>(
    `/commits?sha=${encodeURIComponent(releaseBranch)}&limit=${changelogLimit}`,
  );
}

async function giteaJson<T>(repoPath: string): Promise<T> {
  const response = await fetch(`${repoApiBase()}${repoPath}`, { headers: requestHeaders() });
  if (!response.ok) throw new Error(`Gitea request failed with HTTP ${response.status}.`);
  return await response.json() as T;
}

function requestHeaders(): Record<string, string> {
  const token = process.env.NSTACK_RELEASE_GITEA_TOKEN || process.env.GITEA_TOKEN || "";
  return {
    "Accept": "application/json",
    ...(token ? { "Authorization": `token ${token}` } : {}),
  };
}

function repoApiBase(): string {
  return `${giteaBaseUrl}/api/v1/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}`;
}

function repositoryUrl(): string {
  return `${giteaBaseUrl}/${repositoryOwner}/${repositoryName}`;
}

function releaseCacheKey(): string {
  return `${repositoryOwner}-${repositoryName}-${releaseBranch}`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function normalizeCommit(item: GiteaCommitResponse): ReleaseChange | null {
  const message = firstLine(item.commit?.message || "");
  const commit = String(item.sha || "").slice(0, 12);
  if (!message || !commit) return null;
  return {
    commit,
    message,
    date: item.commit?.committer?.date || item.commit?.author?.date || "",
    url: item.html_url || item.url || "",
  };
}

function firstLine(value: string): string {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function cleanBaseUrl(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

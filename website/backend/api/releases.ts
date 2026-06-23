import { api } from "encore.dev/api";
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

const giteaBaseUrl = cleanBaseUrl(process.env.NSTACK_RELEASE_GITEA_URL || "https://git.nik.technology");
const repositoryOwner = process.env.NSTACK_RELEASE_GITEA_OWNER || "angrymouse";
const repositoryName = process.env.NSTACK_RELEASE_GITEA_REPO || "nstack";
const releaseBranch = process.env.NSTACK_RELEASE_GITEA_BRANCH || "main";
const changelogLimit = positiveInteger(process.env.NSTACK_RELEASE_CHANGELOG_LIMIT, 8);
const cacheMinutes = positiveInteger(process.env.NSTACK_RELEASE_CACHE_MINUTES, 15);
const staleCacheHours = positiveInteger(process.env.NSTACK_RELEASE_STALE_CACHE_HOURS, 24);

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

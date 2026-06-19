export function objectStorageBucketName(appId, bucket) {
  return compactResourceName([appId, bucket.name || "bucket"], 63);
}

function compactResourceName(parts, maxLength) {
  const cleaned = parts.map(cleanResourcePart).filter(Boolean);
  if (cleaned.length === 0) return "resource";
  const full = cleaned.join("-");
  if (full.length <= maxLength) return full;

  const suffix = cleaned.at(-1).slice(0, Math.min(32, maxLength - 2));
  const prefixBudget = Math.max(1, maxLength - suffix.length - 1);
  const prefix = cleaned.slice(0, -1).join("-").slice(0, prefixBudget);
  return cleanResourcePart(`${prefix}-${suffix}`) || suffix || "resource";
}

function cleanResourcePart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-");
}

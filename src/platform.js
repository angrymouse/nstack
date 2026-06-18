const allowedArchitectures = new Set(["amd64", "arm64"]);

export function normalizeTargetPlatform(value = "linux/amd64") {
  const input = String(value || "linux/amd64").trim().toLowerCase();
  const normalized = input.includes("/") ? input : `linux/${input}`;
  const [os, arch, extra] = normalized.split("/");
  if (extra || os !== "linux" || !allowedArchitectures.has(arch)) {
    throw new Error(`Unsupported target platform "${value}". Use linux/amd64 or linux/arm64.`);
  }
  return { os, arch, value: `${os}/${arch}` };
}

export function platformCheck(value) {
  try {
    normalizeTargetPlatform(value);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

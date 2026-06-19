export function stringifyYaml(value) {
  return `${renderValue(value, 0)}\n`;
}

function renderValue(value, indent) {
  if (Array.isArray(value)) return renderArray(value, indent);
  if (value && typeof value === "object") return renderObject(value, indent);
  return renderScalar(value);
}

function renderObject(value, indent) {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return "{}";
  const pad = " ".repeat(indent);
  return entries.map(([key, item]) => {
    if (isScalar(item)) return `${pad}${renderKey(key)}: ${renderScalar(item)}`;
    if (isEmptyObject(item)) return `${pad}${renderKey(key)}: {}`;
    return `${pad}${renderKey(key)}:\n${renderValue(item, indent + 2)}`;
  }).join("\n");
}

function renderArray(value, indent) {
  if (value.length === 0) return "[]";
  const pad = " ".repeat(indent);
  return value.map((item) => {
    if (isScalar(item)) return `${pad}- ${renderScalar(item)}`;
    const rendered = renderValue(item, indent + 2);
    return `${pad}- ${rendered.trimStart()}`;
  }).join("\n");
}

function renderScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(String(value));
}

function renderKey(value) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : renderScalar(value);
}

function isScalar(value) {
  return value === null || typeof value !== "object";
}

function isEmptyObject(value) {
  return value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0;
}

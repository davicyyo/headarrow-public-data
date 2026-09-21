import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_URL = String(process.env.CLOUDFLARE_CONTENT_URL || "").replace(/\/$/, "");
const SYNC_SECRET = String(process.env.CLOUDFLARE_SYNC_SECRET || "");
const DRY_RUN = process.env.CLOUDFLARE_SYNC_DRY_RUN === "1";
const IMAGE_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
const JSON_RE = /^(?:[^/]+\.json|games\/[^/]+\.json|developers\/[^/]+\.json)$/i;

if (!DRY_RUN && (!CONTENT_URL || !SYNC_SECRET)) {
  throw new Error("CLOUDFLARE_CONTENT_URL and CLOUDFLARE_SYNC_SECRET must be configured as repository secrets");
}

const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tree = readGitTree();
const assets = new Map(tree.filter(item => IMAGE_RE.test(item.path)).map(item => [item.path, item]));
const jsonFiles = tree.filter(item => JSON_RE.test(item.path));

if (!DRY_RUN) await uploadAssets([...assets.values()]);

const files = {};
for (const item of jsonFiles) {
  const raw = await readFile(item.path, "utf8");
  const content = rewriteRepositoryImages(JSON.parse(raw), assets);
  files[item.path] = { sha: item.sha, size: item.size, content };
}

const catalog = {
  version: 1,
  commitSha,
  generatedAt: new Date().toISOString(),
  main: files["main.json"]?.content || {},
  menu: files["menu.json"]?.content || {},
  creditsMenu: files["credits_menu.json"]?.content || {},
  games: collectDirectory(files, "games"),
  developers: collectDirectory(files, "developers"),
  files,
  assets: Object.fromEntries([...assets].map(([assetPath, item]) => [assetPath, {
    sha: item.sha,
    size: item.size,
  }])),
};

if (!DRY_RUN) {
  const response = await workerFetch("/internal/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(catalog),
  });
  if (!response.ok) throw new Error(`Catalog upload failed (${response.status}): ${await response.text()}`);
}

console.log(`${DRY_RUN ? "Validated" : "Synchronized"} ${Object.keys(catalog.games).length} games, ${Object.keys(catalog.developers).length} developers and ${assets.size} media files at ${commitSha}.`);

function readGitTree() {
  const output = execFileSync("git", ["ls-tree", "-r", "-l", "HEAD"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return output.trim().split("\n").filter(Boolean).map(line => {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\s+(\d+|-)\t(.+)$/);
    if (!match) throw new Error(`Cannot parse git tree entry: ${line}`);
    return { sha: match[1], size: Number(match[2]) || 0, path: match[3] };
  });
}

async function uploadAssets(items) {
  let next = 0;
  const workers = Array.from({ length: Math.min(6, Math.max(items.length, 1)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      const endpoint = `/internal/media/${item.sha}/${encodePath(item.path)}`;
      const existing = await workerFetch(endpoint, { method: "HEAD" });
      if (existing.ok) continue;
      if (existing.status !== 404) throw new Error(`Media check failed for ${item.path}: ${existing.status}`);

      const body = await readFile(item.path);
      const uploaded = await workerFetch(endpoint, {
        method: "PUT",
        headers: { "content-type": contentTypeForPath(item.path) },
        body,
      });
      if (!uploaded.ok) throw new Error(`Media upload failed for ${item.path} (${uploaded.status}): ${await uploaded.text()}`);
      console.log(`Uploaded ${item.path}`);
    }
  });
  await Promise.all(workers);
}

function collectDirectory(files, directory) {
  const prefix = `${directory}/`;
  return Object.fromEntries(Object.entries(files)
    .filter(([filePath]) => filePath.startsWith(prefix))
    .map(([filePath, item]) => [path.posix.basename(filePath, ".json"), item.content]));
}

function rewriteRepositoryImages(value, assets) {
  if (typeof value === "string") {
    const assetPath = repositoryAssetPath(value);
    const asset = assetPath ? assets.get(assetPath) : null;
    return asset ? `media://${asset.sha}/${assetPath}` : value;
  }
  if (Array.isArray(value)) return value.map(item => rewriteRepositoryImages(item, assets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteRepositoryImages(item, assets)]));
  }
  return value;
}

function repositoryAssetPath(value) {
  const text = String(value || "").trim();
  if (/^assets\//i.test(text)) return decodeURIComponent(text.split(/[?#]/)[0]);
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (host === "raw.githubusercontent.com" && parts[0] === "davicyyo" && parts[1] === "headarrow-public-data") {
      const assetsIndex = parts.indexOf("assets", 2);
      if (assetsIndex >= 0) return parts.slice(assetsIndex).join("/");
    }
    if (host === "github.com" && parts[0] === "davicyyo" && parts[1] === "headarrow-public-data" && parts[2] === "blob") {
      const assetsIndex = parts.indexOf("assets", 4);
      if (assetsIndex >= 0) return parts.slice(assetsIndex).join("/");
    }
  } catch {}
  return "";
}

function workerFetch(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${SYNC_SECRET}`);
  return fetch(`${CONTENT_URL}${endpoint}`, { ...options, headers });
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return ({ avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" })[extension] || "application/octet-stream";
}

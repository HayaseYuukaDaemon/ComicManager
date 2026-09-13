import { loadReaderPage } from "./viewer-image-cache.js?v=full-cache-1";

const DOMAIN = "gold-usergeneratedcontent.net";
const PROXY_BASE = "https://document-worker.hayaseyuuka.date/";
const PROXY_REFERER = "https://hitomi.la";

export function getHitomiId({ search = "", pathname = "" }) {
  const params = new URLSearchParams(search);
  let value = params.get("hitomi_id") || params.get("id");
  if (!value) {
    for (const part of pathname.split("/").filter(Boolean).reverse()) {
      const match = part.match(/(\d+)(?:\.html)?$/);
      if (match) {
        value = match[1];
        break;
      }
    }
  }
  const id = Number(value);
  if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(id) || id <= 0)
    throw new Error("URL 错误：请提供有效的 Hitomi ID（?id=3886065）。");
  return id;
}

export function parseGalleryInfo(rawText) {
  // galleries/*.js 是变量赋值，只解析其中的 JSON，不执行返回的脚本。
  const match = rawText.match(
    /^\s*(?:(?:var|let|const)\s+)?galleryinfo\s*=\s*(\{[\s\S]*\})\s*;?\s*$/,
  );
  if (!match) throw new Error("galleryinfo 解析失败。");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("galleryinfo 解析失败。");
  }
}

export function hitomiImageUrl(file, routing) {
  const hash = file?.hash;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    throw new Error("Hitomi 图片信息不完整，请重试。");
  // 保留 Hitomi common.js 的 WebP 分片规则，并使用 gg.js 的当前路径与映射。
  const shard = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
  const host = `w${1 + routing.m(shard)}.${DOMAIN}`;
  const imageUrl = `https://${host}/${routing.b}${routing.s(hash)}/${hash}.webp`;
  const proxyUrl = new URL(PROXY_BASE);
  proxyUrl.searchParams.set("urlToProxy", imageUrl);
  proxyUrl.searchParams.set("refererURL", PROXY_REFERER);
  return proxyUrl.href;
}

export async function loadHitomiDocument(
  signal,
  { pageLocation = globalThis.location, routing = globalThis.gg } = {},
) {
  const id = getHitomiId(pageLocation);
  if (
    !routing ||
    typeof routing.m !== "function" ||
    typeof routing.s !== "function" ||
    !routing.b
  )
    throw new Error("gg.js 未正确加载，请刷新页面重试。");
  signal.throwIfAborted();
  const response = await fetch(`https://ltn.${DOMAIN}/galleries/${id}.js`, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok)
    throw new Error(`拉取 galleries/${id}.js 失败（HTTP ${response.status}）。`);
  const gallery = parseGalleryInfo(await response.text());
  signal.throwIfAborted();
  if (Number(gallery.id) !== id)
    throw new Error("Hitomi 返回了其他画廊，请重试。");
  if (!Array.isArray(gallery.files) || !gallery.files.length)
    throw new Error("未解析到任何图片 URL。");
  // files 的顺序即阅读顺序，不能根据文件名或 hash 重新排序。
  const urls = gallery.files.map((file) => hitomiImageUrl(file, routing));
  return {
    title: `${gallery.title || `Hitomi #${id}`} - Hitomi Viewer`,
    pages: urls.map((_, index) => ({ index })),
    loadPage: (index, pageSignal) =>
      loadReaderPage(() => urls[index], pageSignal),
  };
}

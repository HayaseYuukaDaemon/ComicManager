import { libraryReturn } from "./comic-library.js";

export const DEFAULT_VIEWER_URL = "/dmb-viewer.html";

export function validateViewerUrl(value, base) {
  const input = value.trim() || DEFAULT_VIEWER_URL;
  if (!/^https?:\/\//i.test(input) && !input.startsWith("/"))
    throw new Error("阅览器地址须为 HTTP / HTTPS 地址或以 / 开头的本站路径。");
  const url = new URL(input, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("请输入不带账号密码的 HTTP / HTTPS 阅览器地址。");
  // Keep the built-in path relative so saved settings also work on another host.
  return input.startsWith("/") && url.origin === new URL(base).origin
    ? url.pathname + url.search + url.hash
    : url.href;
}

function requireComicId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("无效的漫画 ID。");
}

export function viewerLink(value, id, base) {
  requireComicId(id);
  const url = new URL(validateViewerUrl(value, base), base);
  url.searchParams.set("id", String(id));
  return url.href;
}

export function comicDetailLink(id, back = "#/") {
  requireComicId(id);
  return `#/comic/${id}?${new URLSearchParams({ back: libraryReturn(back) })}`;
}

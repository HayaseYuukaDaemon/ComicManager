import { loadReaderPage } from "./viewer-image-cache.js?v=full-cache-1";

const DMB_URL = "https://dmb.hayaseyuuka.date";

async function fetchDmb(path, signal, { text = false } = {}) {
  const response = await fetch(`${DMB_URL}${path}`, {
    credentials: "omit",
    cache: "no-store",
    redirect: text ? "error" : "follow",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok)
    throw new Error(`归档读取失败（HTTP ${response.status}），请重试。`);
  return text ? response.text() : response.json();
}

export async function loadDmbDocument(signal, pageLocation = globalThis.location) {
  const value = new URLSearchParams(pageLocation.search).get("id");
  const id = Number(value);
  if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(id) || id <= 0)
    throw new Error("URL 错误：请提供有效的文档 ID。");
  const documentMeta = await fetchDmb(`/v1/documents/${id}?token=viewer`, signal);
  signal.throwIfAborted();
  if (documentMeta.document_id !== id)
    throw new Error("归档返回了其他文档，请重试。");
  if (["deleted", "purged"].includes(documentMeta.status))
    throw new Error("该文档已删除或清理，无法阅览。");
  const pages = [
    ...new Map(
      (Array.isArray(documentMeta.pages) ? documentMeta.pages : [])
        .filter((page) => Number.isSafeInteger(page.index) && page.index >= 0)
        .map((page) => [page.index, page]),
    ).values(),
  ].sort((a, b) => a.index - b.index);
  if (!pages.length) throw new Error("文档内容为空。");
  return {
    title: `${documentMeta.title || `文档 #${id}`} · 阅览`,
    pages,
    loadPage: (index, pageSignal) =>
      loadReaderPage(
        () =>
          fetchDmb(
            `/v1/documents/${id}/pages/${index}?url=1&token=viewer`,
            pageSignal,
            { text: true },
          ),
        pageSignal,
      ),
  };
}

import { DMB_STATUSES } from "./pending-comics.js?v=queue-status-1";
import {
  DOWNLOAD_STATUSES,
  downloadProgress,
  pollDownloads,
} from "./download-progress.js?v=downloads-1";

export function createDownloadPage({ el, empty, getDmbUrl, setService }) {
  const $ = (id) => document.getElementById(id);
  const cards = new Map();
  let stopPolling;
  let pageSignal;
  let hasData = false;
  let paused = false;
  let lastError = "";
  const setText = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };

  function createCard(document) {
    const title = el("h2");
    const source = el("p", { class: "download-source" });
    const status = el("span", { class: "download-status" });
    const numbers = el("span");
    const percent = el("strong");
    const progress = el("progress", {
      max: 100,
      "aria-label": `漫画 #${document.document_id} 下载进度`,
    });
    const error = el("pre");
    const details = el("details", { class: "download-error", hidden: true }, [
      el("summary", {}, "失败原因"),
      error,
    ]);
    const node = el(
      "article",
      { class: "download-item", "data-document-id": document.document_id },
      [
        el("div", { class: "download-heading" }, [
          el("div", {}, [title, source]),
          status,
        ]),
        el("div", { class: "download-numbers" }, [numbers, percent]),
        progress,
        details,
      ],
    );
    return {
      node,
      title,
      source,
      status,
      numbers,
      percent,
      progress,
      details,
      error,
    };
  }

  function render(documents) {
    hasData = true;
    lastError = "";
    $("downloads-error").hidden = true;
    $("downloads-loading").hidden = true;
    $("downloads-summary").hidden = false;
    setText($("downloads-total"), `共 ${documents.length} 部未归档`);
    setText(
      $("downloads-counts"),
      DOWNLOAD_STATUSES.map((status) => {
        const count = documents.filter((row) => row.status === status).length;
        return count ? `${DMB_STATUSES[status]} ${count}` : "";
      })
        .filter(Boolean)
        .join(" · "),
    );
    setText(
      $("downloads-updated"),
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
    );

    const ids = new Set(documents.map((row) => row.document_id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    $("downloads-empty").hidden = documents.length > 0;
    const list = $("downloads-results");
    for (const [index, document] of documents.entries()) {
      let card = cards.get(document.document_id);
      if (!card) {
        card = createCard(document);
        cards.set(document.document_id, card);
      }
      const { done, total, percent } = downloadProgress(document);
      setText(card.title, document.title || `漫画 #${document.document_id}`);
      setText(
        card.source,
        `#${document.document_id} · ${document.source || "未知来源"} #${document.source_document_id || "—"}`,
      );
      setText(card.status, DMB_STATUSES[document.status]);
      card.node.dataset.status = document.status;
      setText(
        card.numbers,
        `${done ?? "—"} / ${total ?? "—"} 页${total === null ? " · 总页数待确认" : ""}`,
      );
      setText(card.percent, percent === null ? "进度待确认" : `${percent}%`);
      if (percent === null) card.progress.removeAttribute("value");
      else card.progress.value = percent;
      card.progress.setAttribute("aria-valuetext", card.numbers.textContent);
      card.details.hidden = !document.error && document.status !== "failed";
      setText(
        card.error,
        typeof document.error === "string" && document.error
          ? document.error
          : "DMB 未提供失败原因。",
      );
      // Preserve expanded failure details and focus across one-second updates.
      if (list.children[index] !== card.node)
        list.insertBefore(card.node, list.children[index] || null);
    }
  }

  function start() {
    stopPolling?.();
    if (pageSignal?.aborted) return;
    paused = false;
    setText($("downloads-toggle"), "暂停刷新");
    setText($("downloads-live"), "每秒自动刷新");
    stopPolling = pollDownloads(getDmbUrl(), {
      signal: pageSignal,
      onData(documents) {
        setService(true);
        render(documents);
      },
      onError(error) {
        setService(false);
        $("downloads-loading").hidden = true;
        const text = `刷新失败：${error.message}${hasData ? " 当前保留上次结果。" : ""} 将自动重试。`;
        if (text !== lastError) setText($("downloads-error"), text);
        lastError = text;
        $("downloads-error").hidden = false;
      },
    });
  }

  $("downloads-toggle").addEventListener("click", () => {
    if (paused) start();
    else {
      stopPolling?.();
      paused = true;
      setText($("downloads-toggle"), "继续刷新");
      setText($("downloads-live"), "已暂停刷新");
      $("downloads-loading").hidden = true;
      $("downloads-error").hidden = true;
    }
  });

  return {
    show(signal) {
      stopPolling?.();
      pageSignal = signal;
      cards.clear();
      hasData = false;
      lastError = "";
      $("downloads-results").replaceChildren();
      $("downloads-empty").replaceChildren(
        empty("暂无未归档记录", "新任务出现后会自动显示。"),
      );
      $("downloads-empty").hidden = true;
      $("downloads-summary").hidden = true;
      $("downloads-error").hidden = true;
      $("downloads-loading").hidden = false;
      start();
    },
  };
}

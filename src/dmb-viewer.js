import {
  createReaderImageCache,
  loadReaderPage,
} from "./viewer-image-cache.js?v=full-cache-1";

const DMB_URL = "https://dmb.hayaseyuuka.date";
const imgElement = document.getElementById("displayedImage");
const viewport = document.querySelector(".viewport");
const loadingState = document.getElementById("loadingState");
const loadingText = document.getElementById("loadingText");
const spinner = loadingState.querySelector(".spinner");
const retryPage = document.getElementById("retryPage");
const currentEl = document.getElementById("current");
const totalEl = document.getElementById("total");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const stepInput = document.getElementById("stepInput");
const cacheSummary = document.getElementById("cacheSummary");
const cacheActivity = document.getElementById("cacheActivity");
const cacheProgress = document.getElementById("cacheProgress");
const retryCache = document.getElementById("retryCache");
let session;
let restoreIndex = 0;
let touchStart;

const current = (entry) =>
  session === entry && !entry.controller.signal.aborted;

function setLoading(text, failed = false) {
  loadingState.hidden = false;
  loadingText.textContent = text;
  loadingState.classList.toggle("has-error", failed);
  spinner.hidden = failed;
  retryPage.hidden = !failed;
  viewport.setAttribute("aria-busy", String(!failed));
}

function renderCache(progress) {
  cacheSummary.textContent = `已缓存 ${progress.ready} / ${progress.total} 页`;
  const parts = [
    progress.pending
      ? "预加载中…"
      : progress.failed
        ? "预加载结束"
        : "全部就绪",
  ];
  if (progress.failed) parts.push(`${progress.failed} 页失败`);
  if (progress.bytes)
    parts.push(`${(progress.bytes / 1024 / 1024).toFixed(1)} MiB`);
  cacheActivity.textContent = parts.join(" · ");
  cacheProgress.max = progress.total || 1;
  cacheProgress.value = progress.ready;
  cacheProgress.setAttribute("aria-valuetext", cacheSummary.textContent);
  retryCache.hidden = !progress.failed;
  retryCache.disabled = progress.pending > 0;
}

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

// 放大和旋转继续交给 Viewer.js；它和主图使用同一个本地 Blob URL。
function updateViewer(entry) {
  if (entry.viewer) {
    entry.viewer.update();
  } else if (typeof window.Viewer === "function") {
    entry.viewer = new window.Viewer(imgElement, {
      inline: false,
      button: true,
      navbar: false,
      title: false,
      toolbar: {
        zoomIn: 1,
        zoomOut: 1,
        oneToOne: 1,
        reset: 1,
        rotateLeft: 1,
        rotateRight: 1,
      },
      transition: false,
      backdrop: true,
      show() {
        entry.zoomOpen = true;
      },
      hidden() {
        entry.zoomOpen = false;
      },
    });
  }
}

function destroyViewer(entry) {
  // hide(true) 先中断 Viewer.js 的在途显示，再销毁实例；之后才能释放 Blob。
  entry?.viewer?.hide(true);
  entry?.viewer?.destroy();
  if (entry) {
    entry.viewer = null;
    entry.zoomOpen = false;
  }
}

async function decodePage(url, signal) {
  signal.throwIfAborted();
  const image = new Image();
  image.decoding = "async";
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => {
        image.removeAttribute("src");
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      image.src = url;
      image.decode().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    image.removeAttribute("src");
  }
}

async function renderImage(entry) {
  if (!current(entry) || !entry.pages.length) return;
  const version = ++entry.imageVersion;
  entry.displayController?.abort();
  const controller = (entry.displayController = new AbortController());
  const key = entry.pages[entry.index].index;
  const ordinal = entry.index + 1;
  const isCurrentImage = () => current(entry) && entry.imageVersion === version;
  entry.displayFailed = false;
  if (entry.zoomOpen) entry.viewer?.hide(true);
  btnPrev.disabled = entry.index === 0;
  btnNext.disabled = entry.index === entry.pages.length - 1;
  currentEl.textContent = String(ordinal);
  imgElement.classList.add("is-loading");
  setLoading(`正在加载第 ${ordinal} 页…`);
  if (entry.cache.peek(key)) loadingState.hidden = true;
  let decoding = false;
  try {
    const page = await entry.cache.show(key);
    if (!isCurrentImage()) return;
    decoding = true;
    await decodePage(
      page.url,
      AbortSignal.any([
        controller.signal,
        entry.controller.signal,
        AbortSignal.timeout(30000),
      ]),
    );
    if (!isCurrentImage()) return;
    decoding = false;
    imgElement.alt = `漫画第 ${ordinal} 页`;
    imgElement.src = page.url;
    imgElement.hidden = false;
    imgElement.classList.remove("is-loading");
    imgElement.classList.add("is-ready");
    loadingState.hidden = true;
    viewport.setAttribute("aria-busy", "false");
    updateViewer(entry);
  } catch (error) {
    if (!isCurrentImage() || controller.signal.aborted) return;
    entry.displayFailed = true;
    destroyViewer(entry);
    if (decoding) entry.cache.invalidate(key);
    imgElement.removeAttribute("src");
    imgElement.hidden = true;
    imgElement.classList.remove("is-ready", "is-loading");
    setLoading(
      `第 ${ordinal} 页加载失败：${error.message || "请重试。"}`,
      true,
    );
  }
}

function stop() {
  const previous = session;
  session = null;
  previous?.controller.abort();
  previous?.displayController?.abort();
  destroyViewer(previous);
  imgElement.removeAttribute("src");
  imgElement.hidden = true;
  imgElement.classList.remove("is-ready", "is-loading");
  previous?.cache?.clear();
  touchStart = null;
}

async function init(startIndex = 0) {
  stop();
  const entry = {
    controller: new AbortController(),
    pages: [],
    index: startIndex,
    imageVersion: 0,
    viewer: null,
    zoomOpen: false,
  };
  session = entry;
  setLoading("正在获取文档列表…");
  btnPrev.disabled = btnNext.disabled = true;
  currentEl.textContent = totalEl.textContent = "—";
  cacheSummary.textContent = "已缓存 0 / — 页";
  cacheActivity.textContent = "等待文档…";
  cacheProgress.max = 1;
  cacheProgress.value = 0;
  cacheProgress.removeAttribute("aria-valuetext");
  retryCache.hidden = true;
  try {
    const value = new URLSearchParams(location.search).get("id");
    const id = Number(value);
    if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(id) || id <= 0)
      throw new Error("URL 错误：请提供有效的文档 ID。");
    const documentMeta = await fetchDmb(
      `/v1/documents/${id}?token=viewer`,
      AbortSignal.any([entry.controller.signal, AbortSignal.timeout(30000)]),
    );
    if (!current(entry)) return;
    if (documentMeta.document_id !== id)
      throw new Error("归档返回了其他文档，请重试。");
    if (["deleted", "purged"].includes(documentMeta.status))
      throw new Error("该文档已删除或清理，无法阅览。");
    const pages = Array.isArray(documentMeta.pages) ? documentMeta.pages : [];
    entry.pages = [
      ...new Map(
        pages
          .filter((page) => Number.isSafeInteger(page.index) && page.index >= 0)
          .map((page) => [page.index, page]),
      ).values(),
    ].sort((a, b) => a.index - b.index);
    if (!entry.pages.length) throw new Error("文档内容为空。");
    entry.index = Math.max(0, Math.min(startIndex, entry.pages.length - 1));
    document.title = `${documentMeta.title || `文档 #${id}`} · 阅览`;
    totalEl.textContent = String(entry.pages.length);
    entry.cache = createReaderImageCache({
      keys: entry.pages.map((page) => page.index),
      load: (index, signal) =>
        loadReaderPage(
          () =>
            fetchDmb(
              `/v1/documents/${id}/pages/${index}?url=1&token=viewer`,
              signal,
              { text: true },
            ),
          signal,
        ),
      onChange: (progress) => {
        if (current(entry)) renderCache(progress);
      },
    });
    void renderImage(entry);
  } catch (error) {
    if (!current(entry)) return;
    setLoading(error.message || "读取失败，请重试。", true);
    cacheActivity.textContent = "文档读取失败";
  }
}

function changeImage(direction) {
  const entry = session;
  if (!entry || !current(entry) || !entry.pages.length) return;
  const input = Number(stepInput.value);
  const step = Number.isSafeInteger(input) && input > 0 ? input : 1;
  const nextIndex = Math.max(
    0,
    Math.min(entry.pages.length - 1, entry.index + direction * step),
  );
  if (nextIndex === entry.index) return;
  entry.index = nextIndex;
  void renderImage(entry);
}

btnPrev.addEventListener("click", () => changeImage(-1));
btnNext.addEventListener("click", () => changeImage(1));
retryPage.addEventListener("click", () => {
  if (session?.pages.length) void renderImage(session);
  else void init();
});
retryCache.addEventListener("click", () => {
  session?.cache?.retryFailed();
  if (session?.displayFailed) void renderImage(session);
});

document.addEventListener("keydown", (event) => {
  if (
    session?.zoomOpen ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.target.closest("input, select, textarea, [contenteditable]")
  )
    return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    changeImage(event.key === "ArrowLeft" ? -1 : 1);
  }
});
viewport.addEventListener(
  "touchstart",
  (event) => {
    touchStart =
      !session?.zoomOpen && event.touches.length === 1
        ? [event.touches[0].clientX, event.touches[0].clientY]
        : null;
  },
  { passive: true },
);
viewport.addEventListener(
  "touchend",
  (event) => {
    if (!touchStart) return;
    const start = touchStart;
    touchStart = null;
    if (session?.zoomOpen || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - start[0];
    const dy = event.changedTouches[0].clientY - start[1];
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
      changeImage(dx > 0 ? -1 : 1);
  },
  { passive: true },
);
viewport.addEventListener(
  "touchcancel",
  () => {
    touchStart = null;
  },
  { passive: true },
);

window.addEventListener("pagehide", () => {
  restoreIndex = session?.index || 0;
  stop();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void init(restoreIndex);
});
void init();

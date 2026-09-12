import {
  DEFAULT_DMB_URL,
  GROUP_NAMES,
  ApiError,
  api,
  query,
  dmb,
  validateDmbUrl,
  sourceLink,
  stableKey,
  genericKey,
  inferGroup,
  mapLimit,
  exactGeneric,
  ensureGeneric,
  exactMapping,
  similarCandidates,
} from "./entry-api.js";
import {
  PENDING_REASONS,
  DMB_STATUSES,
  isQueueDocument,
  timestampNanos,
  documentSummary,
  readComic,
  readComicLibrary,
  readDmbLibrary,
  readLibrariesUntilAnchor,
  retainPendingDocuments,
  compareLibraries,
  completionReason,
  entryQueue,
  entryBlockReason,
  readEntryState,
  readEntryCompletion,
  filterPending,
} from "./pending-comics.js?v=queue-status-1";
import { createLibraryPage } from "./library-page.js?v=id-desc-1";
import { createComicReader } from "./comic-reader.js?v=full-preload-1";
import { libraryReturn } from "./comic-library.js";
import { runBatchEntry } from "./batch-entry.js?v=queue-status-1";
import { createDownloadPage } from "./download-page.js?v=downloads-2";

const $ = (id) => document.getElementById(id);
const groupLabel = (group) => `${GROUP_NAMES[group] || group} · ${group}`;
const statusLabels = {
  loading: "查询中",
  resolved: "已映射",
  recommended: "有推荐",
  unresolved: "待处理",
  saving: "保存中",
  error: "请求失败",
};
const state = {
  view: "browse",
  phase: "idle",
  hash: null,
  groups: [],
  preview: null,
  source: null,
  sourceError: null,
  items: [],
  active: null,
  pendingWrites: 0,
  createdGeneric: new Set(),
  createdSpecific: new Set(),
  message: null,
  queueSearch: "",
  queueStatus: "all",
  queueGroup: "all",
  lastLibraryHash: "#/",
  existingComic: null,
};
const pending = {
  documents: null,
  comics: null,
  comparison: null,
  controller: null,
  phase: "idle",
  refreshIds: new Set(),
  scannedAt: null,
  mode: "anchor",
  anchor: null,
  scanned: 0,
  cmMinId: 0,
  cmTotal: null,
  offset: 0,
  search: "",
  reason: "all",
  status: "all",
};
const batchEntry = {
  running: false,
  stopRequested: false,
  phase: "idle",
  total: 0,
  current: null,
  results: [],
  notice: null,
};
let dmbUrl = DEFAULT_DMB_URL;
let imageRoute = "proxy";
try {
  if (localStorage.getItem("comicmanager.imageRoute") === "direct")
    imageRoute = "direct";
} catch {
  /* 使用签发原地址 */
}
try {
  dmbUrl = validateDmbUrl(
    localStorage.getItem("comicmanager.dmbUrl") || DEFAULT_DMB_URL,
  );
} catch {
  /* 使用默认地址 */
}
let pageController = new AbortController();
let searchController;
let searchTimer;
let libraryController;
let libraryDetailController;
let routeVersion = 0;
let activeSearchVersion = 0;

function restoreEntryQueue() {
  try {
    const records = JSON.parse(
      localStorage.getItem(`comicmanager.entryQueue:${dmbUrl}`) || "[]",
    );
    if (Array.isArray(records))
      pending.documents = new Map(
        records
          .filter(
            (row) =>
              isQueueDocument(row) &&
              Number.isSafeInteger(row.document_id) &&
              row.document_id >= 0,
          )
          .map((row) => [row.document_id, row]),
      );
  } catch {
    /* 存储不可用时，队列仍在本页面内保留。 */
  }
}
function updatePendingComparison() {
  pending.comparison = compareLibraries(pending.documents, pending.comics, {
    full: pending.mode === "full",
    cmMinId: pending.cmMinId,
  });
  if (pending.cmMinId === 0) pending.cmTotal = pending.comparison.cmTotal;
  try {
    localStorage.setItem(
      `comicmanager.entryQueue:${dmbUrl}`,
      JSON.stringify(
        entryQueue(pending.comparison.pending).map((row) => row.document),
      ),
    );
  } catch {
    /* 不影响本次扫描与录入。 */
  }
}
// comparison.pending 已按时间排序，不必在每次渲染表格行时重新排序整个队列。
const nextEntry = () =>
  pending.comparison?.pending.find((row) => isQueueDocument(row.document));
restoreEntryQueue();

// 所有来源名称与 metadata 都作为文本节点输出。
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on"))
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value;
    else if (
      ["disabled", "checked", "selected", "hidden", "open"].includes(key)
    )
      node[key] = !!value;
    else if (value !== null && value !== undefined)
      node.setAttribute(key, value);
  }
  for (const child of [children].flat(Infinity)) {
    if (child !== null && child !== undefined)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
}
function button(
  text,
  action,
  className = "btn btn-outline-secondary",
  attrs = {},
) {
  return el(
    "button",
    { type: "button", class: className, onclick: action, ...attrs },
    text,
  );
}
function rawDetails(title, data, open = false) {
  return el("details", { class: "raw-details", open }, [
    el("summary", {}, title),
    el("pre", {}, JSON.stringify(data, null, 2)),
  ]);
}
function setService(connected) {
  $("service-state").className =
    `service-label ${connected ? "connected" : "failed"}`;
  $("service-state").replaceChildren(
    el("span", { class: "status-dot" }),
    document.createTextNode(connected ? "DMB 已连接" : "DMB 未连接"),
  );
}
function announce(text) {
  $("announcer").textContent = text;
}
function message(text, type = "warning", error = null, retry = null) {
  state.message = { text, type, error, retry };
  renderMessage();
}
function errorBox(error, retry, text = error.message) {
  const body = el("div", { class: "message-body" }, el("p", {}, text));
  if (error.status === 401 || error.code === "AUTHENTICATION_REQUIRED") {
    body.append(
      el("a", { href: "/auth", class: "d-block mt-2" }, "前往身份验证"),
    );
  }
  if (error.code === "META_SCHEMA_VIOLATION")
    body.append(
      el(
        "p",
        { class: "mt-2" },
        "来源标签结构与数据库不一致，请联系维护者处理。",
      ),
    );
  if (error.code || Object.keys(error.details || {}).length)
    body.append(rawDetails("错误详情", { code: error.code, ...error.details }));
  return el("div", { class: "alert alert-danger", role: "alert" }, [
    body,
    retry && error.code !== "META_SCHEMA_VIOLATION"
      ? button("重试", retry, "btn btn-sm btn-outline-secondary")
      : null,
  ]);
}
function renderMessage() {
  const box = $("global-message");
  box.replaceChildren();
  if (!state.message) return;
  const { text, type, error, retry } = state.message;
  const node = error
    ? errorBox(error, retry, text)
    : el(
        "div",
        { class: `alert alert-${type}` },
        el("div", { class: "message-body" }, text),
      );
  node.append(
    button(
      "×",
      () => {
        state.message = null;
        renderMessage();
      },
      "btn btn-sm btn-quiet",
      { "aria-label": "关闭提示" },
    ),
  );
  box.append(node);
}
function options(select, selected = "", placeholder = false) {
  select.replaceChildren(
    ...(placeholder ? [el("option", { value: "" }, "请选择分类")] : []),
    ...state.groups.map((group) =>
      el("option", { value: group }, groupLabel(group)),
    ),
  );
  select.value = selected;
}
async function loadGroups(signal) {
  if (!state.groups.length)
    state.groups = (await api("/tags/groups", { signal })).data;
}
const unresolved = () =>
  state.items.filter((item) => item.status !== "resolved");
const dirty = () => state.items.some((item) => item.dirty);
const canCommit = () =>
  !!state.preview &&
  nextEntry()?.id === state.comicId &&
  unresolved().length === 0 &&
  state.pendingWrites === 0 &&
  ["resolving", "review"].includes(state.phase);

function showPage(view) {
  state.view = view;
  for (const name of [
    "browse",
    "reader",
    "entry",
    "loading",
    "tags",
    "pending",
    "downloads",
  ])
    $(name + "-page").hidden = name !== view;
  const activeNav = ["browse", "reader"].includes(view)
    ? "browse"
    : ["tags", "pending", "downloads"].includes(view)
      ? view
      : "entry";
  for (const name of ["browse", "entry", "tags", "pending", "downloads"]) {
    if (name === activeNav)
      $("nav-" + name).setAttribute("aria-current", "page");
    else $("nav-" + name).removeAttribute("aria-current");
  }
}

async function route() {
  const hash = location.hash || "#/";
  if (state.hash !== null && hash !== state.hash) {
    if (state.pendingWrites || state.phase === "committing") {
      history.replaceState(null, "", state.hash);
      message(
        batchEntry.running
          ? "正在批量录入，可先点击“停止录入”，完成当前漫画后即可离开。"
          : "正在保存，请等待操作完成。",
      );
      return;
    }
    if (
      dirty() &&
      !confirm("当前尚未保存的标签选择将被清除，是否离开？已保存的映射会保留。")
    ) {
      history.replaceState(null, "", state.hash);
      return;
    }
  }
  state.hash = hash;
  pageController.abort();
  reader.stop();
  pending.controller?.abort();
  pageController = new AbortController();
  searchController?.abort();
  libraryController?.abort();
  libraryDetailController?.abort();
  clearTimeout(searchTimer);
  const version = ++routeVersion;
  state.message = null;
  state.items = [];
  state.preview = null;
  state.existingComic = null;
  state.phase = "idle";
  renderMessage();
  const match = hash.match(/^#\/entry\/(\d+)(?:\?(.*))?$/);
  const readMatch = hash.match(/^#\/read\/(\d+)(?:\?(.*))?$/);
  if (
    hash === "#/entry" ||
    (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0)
  ) {
    document.title = "顺序录入 · ComicManager";
    showPage("pending");
    if (pending.phase !== "ready" || pending.refreshIds.size)
      await scanPending(
        pending.phase === "ready" && pending.refreshIds.size > 0,
      );
    if (version !== routeVersion) return;
    if (pending.phase !== "ready" || pending.refreshIds.size) {
      state.hash = "#/pending";
      history.replaceState(null, "", state.hash);
      return;
    }
    const row = nextEntry();
    const requested = match ? Number(match[1]) : row?.id;
    if (!row || requested !== row.id || entryBlockReason(row)) {
      state.hash = "#/pending";
      history.replaceState(null, "", state.hash);
      renderPending();
      if (row && requested !== row.id)
        message(`请按队列顺序处理，当前下一部是 #${row.id}。`, "warning");
      return;
    }
    $("entry-back").href = "#/pending";
    $("entry-back").textContent = "← 返回待处理队列";
    state.hash = `#/entry/${row.id}`;
    history.replaceState(null, "", state.hash);
    await loadEntry(row.id, version);
  } else if (
    readMatch &&
    Number.isSafeInteger(Number(readMatch[1])) &&
    Number(readMatch[1]) > 0
  ) {
    document.title = "漫画阅读 · ComicManager";
    showPage("reader");
    await reader.show(
      Number(readMatch[1]),
      new URLSearchParams(readMatch[2] || ""),
      pageController.signal,
    );
  } else if (hash === "#/pending") {
    document.title = "待处理队列 · ComicManager";
    showPage("pending");
    if (pending.phase === "ready" && !pending.refreshIds.size) renderPending();
    else
      await scanPending(
        pending.phase === "ready" && pending.refreshIds.size > 0,
      );
  } else if (hash === "#/downloads") {
    document.title = "下载进度 · ComicManager";
    showPage("downloads");
    downloadPage.show(pageController.signal);
  } else if (hash === "#/tags") {
    document.title = "标签管理 · ComicManager";
    showPage("tags");
    try {
      await loadGroups(pageController.signal);
      if (version !== routeVersion) return;
      options($("library-group"), state.groups[0]);
      await loadLibrary();
    } catch (error) {
      if (version === routeVersion)
        message(error.message, "danger", error, route);
    }
  } else {
    document.title = "漫画库 · ComicManager";
    showPage("browse");
    window.scrollTo({ top: 0 });
    state.lastLibraryHash = libraryReturn(hash);
    $("nav-browse").href = state.lastLibraryHash;
    await browserPage.show(hash, pageController.signal);
  }
}

function empty(title, subtitle = "") {
  return el("div", { class: "empty-state" }, [
    el("span", { class: "empty-symbol", "aria-hidden": "true" }, "⌁"),
    el("strong", {}, title),
    el("p", {}, subtitle),
  ]);
}

function timeNode(value, absent = "时间缺失") {
  if (timestampNanos(value) === null)
    return el(
      "span",
      { class: "text-secondary", title: value || "" },
      value ? "时间无法读取" : absent,
    );
  return el(
    "time",
    { datetime: value, title: value },
    new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
  );
}

async function scanPending(localOnly = false, mode = "anchor") {
  if (batchEntry.running) return;
  pending.controller?.abort();
  const controller = (pending.controller = new AbortController());
  const signal = AbortSignal.any([controller.signal, pageController.signal]);
  const current = () =>
    pending.controller === controller &&
    state.view === "pending" &&
    !pageController.signal.aborted;
  pending.phase = "scanning";
  pending.offset = 0;
  $("pending-content").hidden = true;
  $("pending-error").replaceChildren();
  $("pending-refresh").disabled = $("pending-full-scan").disabled = true;
  $("pending-cancel").hidden = false;
  $("pending-progress").hidden = false;
  const counts = { dmb: 0, cm: 0, total: null };
  const refreshIds = [...pending.refreshIds];
  const progress = () => {
    if (current() && !signal.aborted)
      $("pending-progress").textContent = localOnly
        ? `正在核对已处理漫画… ${counts.cm} / ${refreshIds.length} 部`
        : `${mode === "anchor" ? "正在按 anchor 扫描" : "正在全量扫描"}… DMB ${counts.dmb} 条 · CM ${counts.cm}${counts.total === null ? "" : ` / ${counts.total}`} 条`;
  };
  progress();
  try {
    const cmOptions = {
      signal,
      onProgress: ({ loaded, total }) => {
        counts.cm = loaded;
        counts.total = total;
        progress();
      },
    };
    let comics,
      cmTotal,
      cmMinId = 0;
    let documents = pending.documents || new Map();
    let anchor = pending.anchor;
    if (localOnly) {
      // 只重查刚处理过的 ID，保留其余扫描结果及 CM 分页覆盖范围。
      comics = new Map(pending.comics);
      documents = new Map(documents);
      await mapLimit(refreshIds, 6, async (id) => {
        const result = await readEntryState(dmbUrl, id, { signal });
        comics.set(id, result.comic);
        documents.set(id, result.document);
        counts.cm++;
        progress();
      });
      cmTotal = pending.cmTotal;
      cmMinId = pending.cmMinId;
    } else if (mode === "anchor") {
      const result = await readLibrariesUntilAnchor(dmbUrl, {
        signal,
        onProgress: ({ dmbLoaded, cmLoaded, cmTotal }) => {
          counts.dmb = dmbLoaded;
          counts.cm = cmLoaded;
          counts.total = cmTotal;
          progress();
        },
      });
      ({ documents, comics, anchor, cmTotal } = result);
      cmMinId = result.cmComplete ? 0 : result.cmMinId;
      counts.dmb = result.dmbLoaded;
    } else {
      [documents, comics] = await Promise.all([
        readDmbLibrary(dmbUrl, {
          signal,
          onProgress: ({ loaded }) => {
            counts.dmb = loaded;
            progress();
          },
        }),
        readComicLibrary(cmOptions),
      ]);
      cmTotal = comics.size;
      anchor = null;
    }
    if (!localOnly) {
      // 只合并原队列；上次全量扫描已经完成的条目不能因为 CM 本次尚未读到而重新入队。
      const queued = pending.comparison
        ? new Map(
            pending.comparison.pending
              .filter((row) => row.document)
              .map((row) => [row.id, row.document]),
          )
        : pending.documents;
      documents = retainPendingDocuments(documents, queued, comics);
    }
    if (!current() || signal.aborted) return;
    pending.documents = documents;
    pending.comics = comics;
    pending.cmMinId = cmMinId;
    pending.cmTotal = cmTotal;
    if (!localOnly) pending.mode = mode;
    updatePendingComparison();
    pending.phase = "ready";
    if (localOnly) for (const id of refreshIds) pending.refreshIds.delete(id);
    if (!localOnly) {
      pending.anchor = anchor;
      pending.scanned = counts.dmb;
      pending.scannedAt = new Date();
      setService(true);
    }
    renderPending();
    announce(
      `队列已更新，${entryQueue(pending.comparison.pending).length} 部等待处理。`,
    );
  } catch (error) {
    if (!current()) return;
    const stopped = signal.aborted;
    controller.abort();
    pending.phase = "ready";
    if (pending.comparison) renderPending();
    else pending.phase = stopped ? "stopped" : "error";
    $("pending-progress").hidden = false;
    $("pending-progress").textContent = localOnly
      ? stopped
        ? "核对已停止，原有队列保留。"
        : "核对未完成，原有队列保留，请重试当前漫画。"
      : stopped
        ? "扫描已停止，原有队列保留。"
        : "扫描未完成，原有队列保留，未加入本次不完整结果。";
    if (!stopped)
      $("pending-error").replaceChildren(
        errorBox(error, () => scanPending(localOnly, mode)),
      );
  } finally {
    if (current()) {
      $("pending-refresh").disabled = $("pending-full-scan").disabled = false;
      $("pending-cancel").hidden = true;
    }
  }
}

function renderNextEntry() {
  const row = nextEntry();
  const count = entryQueue(pending.comparison.pending).length;
  const blocked = row && entryBlockReason(row);
  $("pending-next").replaceChildren(
    el("div", {}, [
      el("h2", {}, row ? "下一部" : "队列已处理完"),
      row
        ? el("strong", {}, `#${row.id} · ${row.document.title || "未命名漫画"}`)
        : null,
      el(
        "p",
        {},
        row
          ? [timeNode(row.document.updated_at), ` · ${count} 部等待处理`]
          : "可以再次扫描，把新发现的漫画加入队列。",
      ),
      blocked
        ? el("p", { class: "text-danger" }, `${blocked}，当前部保留在队首。`)
        : null,
    ]),
    row && !blocked
      ? el(
          "a",
          {
            href: "#/entry",
            class: "btn btn-primary",
            "aria-disabled": batchEntry.running,
          },
          row.comic ? "处理下一部 · 更新漫画 →" : "处理下一部 →",
        )
      : "",
  );
}

function renderPending() {
  if (state.view !== "pending" || pending.phase !== "ready") return;
  const comparison = pending.comparison;
  $("pending-progress").hidden = true;
  $("pending-error").replaceChildren();
  $("pending-content").hidden = false;
  $("pending-refresh").disabled = false;
  $("pending-cancel").hidden = true;
  $("pending-full-scan").disabled = false;
  $("pending-stats").replaceChildren(
    el("strong", {}, `${entryQueue(comparison.pending).length} 部等待处理`),
    el(
      "span",
      {},
      `${pending.mode === "anchor" ? "Anchor" : "全量"} 扫描 · 本次读取 DMB ${pending.scanned} 条 · CM ${comparison.cmTotal} / ${pending.cmTotal} 条`,
    ),
    el(
      "small",
      {},
      pending.mode === "anchor"
        ? pending.anchor
          ? `Anchor #${pending.anchor.document_id} · 已读完相同更新时间的记录`
          : "未遇到 anchor，已扫描全部活动记录"
        : "全量结果已加入队列",
    ),
    pending.scannedAt
      ? el(
          "small",
          {},
          `扫描于 ${pending.scannedAt.toLocaleTimeString("zh-CN", { hour12: false })}`,
        )
      : null,
  );
  const records = filterPending(comparison.pending, pending);
  pending.offset = Math.min(
    pending.offset,
    Math.max(0, Math.ceil(records.length / 20) - 1) * 20,
  );
  const page = records.slice(pending.offset, pending.offset + 20);
  $("pending-results").replaceChildren(
    page.length
      ? el("table", { class: "pending-table" }, [
          el(
            "caption",
            { class: "visually-hidden" },
            "未完成漫画与两边的更新时间",
          ),
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              [
                "漫画",
                "未完成原因",
                "DMB 更新时间",
                "CM 更新时间",
                "队列状态",
              ].map((name) => el("th", { scope: "col" }, name)),
            ),
          ),
          el(
            "tbody",
            {},
            page.map((row) =>
              el("tr", { "data-comic-id": row.id }, [
                el("td", { class: "pending-comic" }, [
                  el(
                    "strong",
                    { title: row.document?.title || row.comic?.title || "" },
                    row.document?.title || row.comic?.title || "未命名漫画",
                  ),
                  el("small", {}, [
                    `#${row.id}`,
                    row.document
                      ? ` · ${row.document.source} · 来源 #${row.document.source_document_id}`
                      : " · 仅 CM 中存在",
                  ]),
                  el(
                    "span",
                    { class: "pending-source-status" },
                    DMB_STATUSES[row.document?.status] ||
                      row.document?.status ||
                      "来源缺失",
                  ),
                ]),
                el(
                  "td",
                  { "data-label": "未完成原因" },
                  el(
                    "span",
                    {
                      class: `pending-reason ${row.reason === "missing" ? "" : "needs-attention"}`,
                    },
                    PENDING_REASONS[row.reason],
                  ),
                ),
                el(
                  "td",
                  { "data-label": "DMB 更新时间" },
                  timeNode(
                    row.document?.updated_at,
                    row.document ? "时间缺失" : "无对应记录",
                  ),
                ),
                el(
                  "td",
                  { "data-label": "CM 更新时间" },
                  timeNode(
                    row.comic?.updated_at,
                    row.comic
                      ? "时间缺失"
                      : row.reason === "unchecked"
                        ? "尚未核对"
                        : "未入库",
                  ),
                ),
                el(
                  "td",
                  { class: "pending-row-action" },
                  el(
                    "span",
                    { class: "text-secondary" },
                    !isQueueDocument(row.document)
                      ? "仅供核对"
                      : row.id === nextEntry()?.id
                        ? "下一部"
                        : "等待处理",
                  ),
                ),
              ]),
            ),
          ),
        ])
      : comparison.pending.length
        ? empty("没有匹配的漫画", "调整搜索内容或筛选条件。")
        : empty(
            "没有未完成的漫画",
            comparison.dmbTotal
              ? "当前扫描中的记录均已完成。"
              : "DMB 与 CM 当前都没有记录。",
          ),
  );
  const pageCount = Math.max(1, Math.ceil(records.length / 20));
  const pageInput = el("input", {
    id: "pending-page-number",
    class: "form-control form-control-sm",
    type: "number",
    inputmode: "numeric",
    min: 1,
    max: pageCount,
    step: 1,
    required: true,
    value: Math.floor(pending.offset / 20) + 1,
    disabled: records.length === 0,
    "aria-label": "跳转页码",
  });
  const pageJump = el(
    "form",
    {
      class: "page-jump",
      onsubmit: (event) => {
        event.preventDefault();
        if (!pageInput.reportValidity()) return;
        pending.offset = (pageInput.valueAsNumber - 1) * 20;
        renderPending();
        $("pending-results").scrollIntoView({ block: "start" });
      },
    },
    [
      el("label", { for: "pending-page-number" }, "跳至"),
      pageInput,
      el("span", {}, "页"),
      el(
        "button",
        {
          type: "submit",
          class: "btn btn-sm btn-outline-secondary",
          disabled: records.length === 0,
        },
        "跳转",
      ),
    ],
  );
  $("pending-pagination").replaceChildren(
    el(
      "span",
      {},
      `共 ${records.length} 部 · 第 ${Math.floor(pending.offset / 20) + 1} / ${pageCount} 页`,
    ),
    button(
      "上一页",
      () => {
        pending.offset -= 20;
        renderPending();
        $("pending-results").scrollIntoView({ block: "start" });
      },
      "btn btn-sm btn-quiet",
      { disabled: pending.offset === 0 },
    ),
    button(
      "下一页",
      () => {
        pending.offset += 20;
        renderPending();
        $("pending-results").scrollIntoView({ block: "start" });
      },
      "btn btn-sm btn-quiet",
      { disabled: pending.offset + 20 >= records.length },
    ),
    pageJump,
  );
  renderBatchEntry();
}

function renderBatchEntry() {
  const count = pending.comparison
    ? entryQueue(pending.comparison.pending).length
    : 0;
  $("batch-entry-start").disabled =
    batchEntry.running || state.pendingWrites > 0 || !count;
  $("batch-entry-start").textContent = batchEntry.running
    ? "自动录入中…"
    : `自动录入 ${count} 部`;
  $("batch-entry-stop").hidden = !batchEntry.running;
  $("batch-entry-stop").disabled = batchEntry.stopRequested;
  $("batch-entry-stop").textContent = batchEntry.stopRequested
    ? "完成当前部后停止…"
    : "停止录入";
  $("pending-filters").disabled = batchEntry.running;
  $("pending-refresh").disabled = $("pending-full-scan").disabled =
    batchEntry.running;
  renderNextEntry();
  $("settings-open").disabled = state.pendingWrites > 0;
  const counts = { success: 0, blocked: 0, failed: 0 };
  for (const result of batchEntry.results) counts[result.status]++;
  const phase = {
    idle: "",
    preparing: "正在确认待处理队列…",
    running: batchEntry.stopRequested ? "正在停止" : "正在录入",
    refreshing: "正在刷新 CM 状态…",
    complete: "批量录入完成",
    stopped: "批量录入已停止",
    failed: "批量录入未完成",
  }[batchEntry.phase];
  $("batch-entry-progress").hidden = batchEntry.phase === "idle";
  $("batch-entry-progress").textContent =
    `${phase} · 已处理 ${batchEntry.results.length} / ${batchEntry.total} 部 · 录入 ${counts.success} · 待手动处理 ${counts.blocked} · 失败 ${counts.failed}`;
  $("batch-entry-current").textContent = batchEntry.current
    ? `#${batchEntry.current.id} · ${batchEntry.current.document?.title || "未命名漫画"}`
    : batchEntry.phase === "stopped"
      ? `队列剩余 ${count} 部等待处理`
      : "";
  $("batch-entry-notice").textContent = batchEntry.notice || "";
  $("batch-entry-details").hidden = batchEntry.results.length === 0;
  $("batch-entry-details-label").textContent =
    `查看逐部结果（${batchEntry.results.length}）`;
}

async function startBatchEntry() {
  if (batchEntry.running || state.pendingWrites || pending.phase !== "ready")
    return;
  Object.assign(batchEntry, {
    running: true,
    stopRequested: false,
    phase: "preparing",
    total: 0,
    current: null,
    results: [],
    notice: null,
  });
  $("batch-entry-results").replaceChildren();
  state.pendingWrites++;
  renderBatchEntry();
  try {
    // 筛选只影响展示；始终从整个队列中最早的未完成记录开始。
    const [comics, groups] = await Promise.all([
      readComicLibrary(),
      api("/tags/groups"),
    ]);
    pending.comics = comics;
    pending.cmMinId = 0;
    updatePendingComparison();
    const records = entryQueue(pending.comparison.pending);
    batchEntry.total = records.length;
    batchEntry.phase = "running";
    renderBatchEntry();
    const result = await runBatchEntry(records, {
      groups: groups.data,
      dmbUrl,
      shouldStop: () => batchEntry.stopRequested,
      onCurrent: (row) => {
        batchEntry.current = row;
        renderBatchEntry();
      },
      onResult: (row) => {
        if (row.comic && row.document) {
          pending.comics.set(row.id, row.comic);
          pending.documents.set(row.id, row.document);
          updatePendingComparison();
        }
        batchEntry.results.push(row);
        $("batch-entry-results").prepend(
          el(
            "li",
            { class: `batch-result ${row.status}`, "data-comic-id": row.id },
            [
              el(
                "span",
                { class: "batch-result-status" },
                { success: "已录入", blocked: "待手动处理", failed: "失败" }[
                  row.status
                ],
              ),
              el("span", {}, `#${row.id} · ${row.title}`),
              el("small", {}, row.reason),
            ],
          ),
        );
        renderBatchEntry();
      },
    });
    batchEntry.current = null;
    batchEntry.notice = result.reason || null;
    if (batchEntry.results.length) {
      batchEntry.phase = "refreshing";
      for (const row of batchEntry.results) pending.refreshIds.add(row.id);
      browserPage.clear();
      renderBatchEntry();
      try {
        pending.comics = await readComicLibrary();
        pending.cmMinId = 0;
        updatePendingComparison();
        pending.refreshIds.clear();
      } catch (error) {
        batchEntry.notice =
          `${batchEntry.notice || ""} 录入结果已保留，但 CM 列表刷新失败：${error.message}`.trim();
      }
    }
    batchEntry.phase = result.stopped ? "stopped" : "complete";
  } catch (error) {
    batchEntry.phase = "failed";
    batchEntry.notice = error.message;
  } finally {
    batchEntry.running = false;
    batchEntry.current = null;
    state.pendingWrites--;
    renderPending();
    announce($("batch-entry-progress").textContent);
  }
}

async function loadEntry(
  id,
  version = ++routeVersion,
  notice = null,
  preserveCreated = false,
) {
  state.phase = "loading";
  state.comicId = id;
  state.items = [];
  state.source = null;
  state.sourceError = null;
  state.active = null;
  if (!preserveCreated) {
    state.createdGeneric = new Set();
    state.createdSpecific = new Set();
  }
  showPage("loading");
  const signal = pageController.signal;
  try {
    // 来源详情与 Comic 是独立资源；来源服务暂不可读时仍保留 Comic 预览。
    const sourceResult = dmb(dmbUrl, `/v1/documents/${id}`, { signal }).then(
      (r) => ({ data: r.data }),
      (error) => ({ error }),
    );
    const [preview, , source, comic] = await Promise.all([
      api(`/comics/${id}/preview`, { signal }),
      loadGroups(signal),
      sourceResult,
      readComic(id, { signal }),
    ]);
    if (version !== routeVersion) return;
    state.preview = preview.data;
    state.source = source.data || null;
    state.sourceError = source.error || null;
    state.existingComic = comic;
    pending.comics.set(id, comic);
    if (pending.documents && source.data) {
      pending.documents.set(id, documentSummary(source.data));
    }
    updatePendingComparison();
    if (source.data) pending.refreshIds.delete(id);
    if (nextEntry()?.id !== id || entryBlockReason(nextEntry())) {
      showPage("pending");
      state.hash = "#/pending";
      history.replaceState(null, "", state.hash);
      renderPending();
      message("队列状态已更新，请从下一部继续处理。", "warning");
      return;
    }
    setService(!source.error);
    state.items = [
      ...new Map(
        preview.data.comic_tags.map((tag) => [stableKey(tag), tag]),
      ).entries(),
    ].map(([key, tag]) => ({
      key,
      tag,
      status: "loading",
      mapping: null,
      candidates: [],
      selected: null,
      group: inferGroup(tag, state.groups),
      mode: "recommend",
      name: tag.origin_name,
      searchText: tag.origin_name,
      searchResults: [],
      searchTotal: 0,
      searchOffset: 0,
      searchLoading: false,
      error: null,
      conflict: null,
      dirty: false,
    }));
    state.active = state.items[0]?.key ?? null;
    state.phase = "resolving";
    state.queueSearch = "";
    state.queueStatus = "all";
    state.queueGroup = "all";
    $("queue-search").value = "";
    $("queue-status").value = "all";
    $("queue-group").replaceChildren(
      el("option", { value: "all" }, "全部分组"),
      ...[
        ...new Set(state.items.map((item) => item.tag.group || "无来源分组")),
      ].map((group) => el("option", { value: group }, group)),
    );
    showPage("entry");
    document.title = `${state.preview.title} · 漫画录入`;
    if (notice) message(notice, "warning");
    else if (source.error)
      message(
        "来源详情暂时无法读取；漫画预览已加载。可以重试读取来源数据。",
        "warning",
        source.error,
        refreshSource,
      );
    renderEntry();
    await mapLimit(state.items, 6, (item) =>
      resolveItem(item, version, signal),
    );
    if (version === routeVersion) {
      activate(unresolved()[0]?.key ?? state.items[0]?.key ?? null);
      announce(`标签查询完成，${unresolved().length} 个待处理。`);
    }
  } catch (error) {
    if (version !== routeVersion || signal.aborted) return;
    state.phase = "fatal-error";
    showPage("pending");
    state.hash = "#/pending";
    history.replaceState(null, "", state.hash);
    renderPending();
    message(error.message, "danger", error, () => loadEntry(id));
  }
}

async function refreshSource() {
  const version = routeVersion;
  try {
    const { data } = await dmb(dmbUrl, `/v1/documents/${state.comicId}`, {
      signal: pageController.signal,
    });
    if (version !== routeVersion) return;
    state.source = data;
    state.sourceError = null;
    if (pending.documents) {
      pending.documents.set(state.comicId, documentSummary(data));
      pending.refreshIds.add(state.comicId);
    }
    state.message = null;
    setService(true);
    renderMessage();
    renderSummary();
  } catch (error) {
    if (version === routeVersion)
      message(error.message, "danger", error, refreshSource);
  }
}

async function resolveItem(
  item,
  version = routeVersion,
  signal = pageController.signal,
) {
  item.status = "loading";
  item.error = null;
  item.conflict = null;
  if (version === routeVersion) renderEntry(false);
  try {
    const mapping = await exactMapping(item.tag, signal);
    if (version !== routeVersion) return;
    if (mapping) {
      item.mapping = mapping;
      item.status = "resolved";
      item.dirty = false;
    } else {
      item.mapping = null;
      item.status = "unresolved";
    }
  } catch (error) {
    if (version !== routeVersion || signal.aborted) return;
    item.status = "error";
    item.error = error;
  }
  if (version === routeVersion) {
    renderEntry(state.active === item.key);
    if (state.active === item.key && item.status === "unresolved")
      await loadCandidates(item, version);
  }
}

async function loadCandidates(item, version = routeVersion) {
  if (
    item.candidatesLoaded ||
    item.candidatesLoading ||
    item.status === "resolved"
  )
    return;
  item.candidatesLoading = true;
  renderEntry();
  try {
    const candidates = await similarCandidates(item.tag, pageController.signal);
    if (
      item.group === "group" &&
      !candidates.some(
        (candidate) =>
          candidate.generic.tag_group === "group" &&
          candidate.generic.name === item.tag.origin_name,
      )
    ) {
      const generic = { tag_group: "group", name: item.tag.origin_name };
      const id = await exactGeneric(generic, pageController.signal);
      if (id !== null) candidates.push({ generic, evidence: [] });
    }
    if (version !== routeVersion) return;
    item.candidates = candidates;
    item.candidatesLoaded = true;
    item.status = candidates.length ? "recommended" : "unresolved";
    if (!item.dirty) {
      item.mode = candidates.length ? "recommend" : "create";
      item.selected = candidates.length === 1 ? candidates[0].generic : null;
      if (item.selected) item.group = item.selected.tag_group;
    }
  } catch (error) {
    if (version !== routeVersion || pageController.signal.aborted) return;
    item.status = "error";
    item.error = error;
  } finally {
    item.candidatesLoading = false;
    if (version === routeVersion) renderEntry(state.active === item.key);
  }
}

async function activate(key, focusEditor = false) {
  if (state.pendingWrites) return;
  searchController?.abort();
  clearTimeout(searchTimer);
  ++activeSearchVersion;
  state.active = key;
  const item = state.items.find((item) => item.key === key);
  renderEntry();
  if (item && ["unresolved", "recommended"].includes(item.status))
    await loadCandidates(item);
  window.bootstrap?.Offcanvas.getInstance($("tag-queue"))?.hide();
  if (focusEditor && state.active === key) {
    document
      .querySelector(
        "#tag-editor select:not(:disabled), #tag-editor button:not(:disabled)",
      )
      ?.focus();
  }
}
function nextItem() {
  const index = state.items.findIndex((item) => item.key === state.active);
  const ordered = [
    ...state.items.slice(index + 1),
    ...state.items.slice(0, index + 1),
  ];
  const next = ordered.find((item) => item.status !== "resolved");
  if (next) void activate(next.key, true);
  else {
    state.phase = "review";
    renderEntry();
    announce("全部标签已映射，请复核录入。");
  }
}

function renderSummary() {
  const comic = state.preview;
  if (!comic) return;
  const done = state.items.length - unresolved().length;
  const percent = state.items.length ? (done / state.items.length) * 100 : 100;
  const source = state.source;
  $("comic-summary").replaceChildren(
    el("div", {}, [
      el("div", { class: "source-label" }, [
        el(
          "span",
          { class: "source-badge" },
          source?.source || comic.comic_tags[0]?.site || "归档",
        ),
        el("span", {}, `DMB #${comic.id}`),
        source ? el("span", {}, `来源 #${source.source_document_id}`) : null,
      ]),
      el("h1", {}, comic.title),
      el("div", { class: "summary-meta" }, [
        el("span", {}, comic.authors.join(" / ") || "作者未提供"),
        el("span", {}, `${comic.comic_tags.length} 个来源标签`),
        comic.series_name ? el("span", {}, comic.series_name) : null,
      ]),
    ]),
    el("div", { class: "summary-progress" }, [
      el("span", { class: "progress-number" }, [
        done,
        el("small", {}, ` / ${state.items.length}`),
      ]),
      el("span", { class: "progress-caption" }, "标签映射完成"),
      el(
        "div",
        {
          class: "progress",
          role: "progressbar",
          "aria-label": "标签映射进度",
          "aria-valuemin": "0",
          "aria-valuemax": String(state.items.length || 1),
          "aria-valuenow": String(state.items.length ? done : 1),
        },
        el("div", { class: "progress-bar", style: `width:${percent}%` }),
      ),
    ]),
  );
}
function renderQueue() {
  $("queue-count").textContent = `${state.items.length} 项`;
  const scrollTop = $("queue-list").scrollTop;
  const visible = state.items.filter((item) => {
    const nameMatch = item.tag.origin_name
      .toLowerCase()
      .includes(state.queueSearch.toLowerCase());
    const statusMatch =
      state.queueStatus === "all" ||
      (state.queueStatus === "pending"
        ? item.status !== "resolved"
        : item.status === state.queueStatus);
    return (
      nameMatch &&
      statusMatch &&
      (state.queueGroup === "all" ||
        (item.tag.group || "无来源分组") === state.queueGroup)
    );
  });
  $("queue-list").replaceChildren(
    ...visible
      .map((item) =>
        button("", () => activate(item.key), "queue-item", {
          "aria-current": String(state.active === item.key),
          disabled: state.pendingWrites > 0,
        }),
      )
      .map((node, index) => {
        const item = visible[index];
        node.append(
          el(
            "span",
            { class: `queue-symbol ${item.status}`, "aria-hidden": "true" },
            item.status === "resolved"
              ? "✓"
              : item.status === "error"
                ? "!"
                : "○",
          ),
          el("span", { class: "queue-item-main" }, [
            el("strong", {}, item.tag.origin_name),
            el(
              "small",
              {},
              [item.tag.group || item.tag.site, item.tag.tag_sex]
                .filter(Boolean)
                .join(" · "),
            ),
          ]),
          el(
            "span",
            { class: `queue-state ${item.status}` },
            statusLabels[item.status],
          ),
        );
        return node;
      }),
  );
  if (!visible.length)
    $("queue-list").append(
      el(
        "p",
        { class: "text-secondary p-4 small" },
        "没有符合筛选条件的标签。",
      ),
    );
  $("queue-list").scrollTop = scrollTop;
}
function metadataFields(tag) {
  const names = {
    site: "来源站点",
    group: "原始分组",
    tag_sex: "性别",
    url: "来源链接",
  };
  const entries = Object.entries(tag).filter(([key]) => key !== "origin_name");
  return el(
    "dl",
    { class: "metadata-grid" },
    entries.map(([key, value]) => {
      const href = key === "url" ? sourceLink(value, tag.site) : null;
      return el("div", {}, [
        el("dt", {}, names[key] || key),
        el(
          "dd",
          {},
          href
            ? el(
                "a",
                { href, target: "_blank", rel: "noopener noreferrer" },
                value,
              )
            : value === null
              ? "—"
              : typeof value === "object"
                ? JSON.stringify(value)
                : value,
        ),
      ]);
    }),
  );
}

function renderEditor() {
  const node = $("tag-editor");
  const item = state.items.find((item) => item.key === state.active);
  const active = document.activeElement;
  const focusId = node.contains(active) ? active.id : null;
  const selection =
    active?.selectionStart === undefined
      ? null
      : [active.selectionStart, active.selectionEnd];
  node.replaceChildren();
  if (!item) {
    node.append(empty("这部漫画没有需要整理的标签", "可直接进入最终复核。"));
    return;
  }
  node.append(
    el("div", { class: "editor-eyebrow" }, [
      el("span", {}, "来源标签 / SPECIFIC TAG"),
      el(
        "span",
        {},
        `${state.items.indexOf(item) + 1} / ${state.items.length}`,
      ),
    ]),
    el("h2", { class: "tag-title" }, item.tag.origin_name),
    metadataFields(item.tag),
    rawDetails("查看完整标签数据", item.tag),
  );
  if (item.status === "loading") {
    node.append(el("div", { class: "blank-editor" }, "正在查询精确映射…"));
  } else if (item.status === "resolved") {
    node.append(
      el("div", { class: "resolved-box" }, [
        el("span", {}, "✓ 已映射到通用标签"),
        el("h3", {}, item.mapping.generic.name),
        el("p", {}, groupLabel(item.mapping.generic.tag_group)),
      ]),
      el("div", { class: "editor-actions" }, [
        el("small", {}, "此映射已保存，刷新页面后仍会保留。"),
        button(
          unresolved().length ? "处理下一项 →" : "查看最终复核 →",
          nextItem,
          "btn btn-primary",
        ),
      ]),
    );
  } else if (item.status === "error") {
    node.append(
      errorBox(item.error, () => {
        item.candidatesLoaded = false;
        void resolveItem(item);
      }),
    );
    if (item.conflict) {
      node.append(
        el(
          "p",
          { class: "small" },
          `你选择了「${groupLabel(item.conflict.wanted.tag_group)} / ${item.conflict.wanted.name}」，现有映射为「${groupLabel(item.conflict.actual.generic.tag_group)} / ${item.conflict.actual.generic.name}」。`,
        ),
        button(
          "接受现有映射并继续",
          () => {
            item.mapping = item.conflict.actual;
            item.conflict = null;
            item.error = null;
            item.dirty = false;
            item.status = "resolved";
            nextItem();
          },
          "btn btn-outline-primary",
        ),
      );
    }
  } else {
    renderDecision(node, item);
  }
  if (focusId && $(focusId)) {
    $(focusId).focus({ preventScroll: true });
    if (selection && ["text", "search"].includes($(focusId).type))
      $(focusId).setSelectionRange(...selection);
  }
}

function renderDecision(node, item) {
  const busy = state.pendingWrites > 0 || item.candidatesLoading;
  const area = el("div", { class: "decision-area" });
  const select = el("select", {
    id: "mapping-group",
    class: "form-select",
    disabled: busy,
    onchange: (event) => {
      item.group = event.target.value;
      item.selected = null;
      item.dirty = true;
      if (item.mode === "search") void searchGeneric(item);
      renderEditor();
    },
  });
  options(select, item.group, true);
  area.append(
    el("div", { class: "group-line" }, [
      el("label", { for: "mapping-group" }, "标签分类"),
      select,
      el(
        "small",
        {},
        item.group ? "按语义选择通用分类" : "请根据来源信息选择分类",
      ),
    ]),
  );
  area.append(
    el(
      "div",
      { class: "mode-tabs", role: "tablist", "aria-label": "映射方式" },
      [
        ["recommend", "推荐候选"],
        ["search", "搜索已有标签"],
        ["create", "创建新标签"],
      ].map(([mode, name]) =>
        button(
          name,
          () => {
            item.mode = mode;
            item.selected =
              mode === "recommend" && item.candidates.length === 1
                ? item.candidates[0].generic
                : null;
            if (item.selected) item.group = item.selected.tag_group;
            renderEditor();
            if (mode === "search") void searchGeneric(item);
          },
          "mode-tab",
          {
            role: "tab",
            "aria-selected": String(item.mode === mode),
            disabled: busy,
          },
        ),
      ),
    ),
  );
  if (item.candidatesLoading)
    area.append(
      el("p", { class: "mode-description" }, "正在读取同原名标签的候选映射…"),
    );
  else if (item.mode === "recommend") {
    area.append(
      el(
        "p",
        { class: "mode-description" },
        "相同来源与原名的标签提供以下候选，请确认后采用。",
      ),
    );
    if (!item.candidates.length)
      area.append(
        empty("暂无同原名候选", "可以搜索已有标签，或创建新的通用标签。"),
      );
    else
      area.append(
        ...item.candidates.map((candidate) =>
          candidateNode(candidate, item, busy),
        ),
      );
  } else if (item.mode === "search") {
    const input = el("input", {
      id: "mapping-search",
      type: "search",
      class: "form-control",
      placeholder: "在当前分类中搜索",
      value: item.searchText,
      disabled: busy || !item.group,
      oninput: (event) => {
        item.searchText = event.target.value;
        item.selected = null;
        searchController?.abort();
        ++activeSearchVersion;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => searchGeneric(item), 300);
        updateSaveButton(item);
      },
    });
    area.append(
      el("div", { class: "mapping-form" }, [
        el(
          "label",
          { for: "mapping-search", class: "form-label" },
          "通用标签名称",
        ),
        input,
        el(
          "p",
          { class: "form-text" },
          item.group
            ? `搜索范围：${groupLabel(item.group)}`
            : "先选择标签分类，再搜索已有标签。",
        ),
      ]),
    );
    if (item.searchLoading)
      area.append(el("p", { class: "mode-description" }, "正在搜索…"));
    else if (item.searchError)
      area.append(errorBox(item.searchError, () => searchGeneric(item)));
    else if (item.group && !item.searchResults.length)
      area.append(
        empty("没有匹配的通用标签", "换个名称搜索，或切换到创建新标签。"),
      );
    else
      area.append(
        ...item.searchResults.map((generic) =>
          candidateNode({ generic, evidence: [] }, item, busy),
        ),
      );
    if (item.searchTotal > 10)
      area.append(
        el("div", { class: "pagination-bar" }, [
          button(
            "上一页",
            () => searchGeneric(item, item.searchOffset - 10),
            "btn btn-sm btn-quiet",
            { disabled: item.searchOffset === 0 || item.searchLoading },
          ),
          el("span", {}, `共 ${item.searchTotal} 项`),
          button(
            "下一页",
            () => searchGeneric(item, item.searchOffset + 10),
            "btn btn-sm btn-quiet",
            {
              disabled:
                item.searchOffset + 10 >= item.searchTotal ||
                item.searchLoading,
            },
          ),
        ]),
      );
  } else {
    area.append(
      el("div", { class: "mapping-form" }, [
        el(
          "label",
          { for: "mapping-name", class: "form-label" },
          "新通用标签名称",
        ),
        el("input", {
          id: "mapping-name",
          class: "form-control",
          type: "text",
          value: item.name,
          disabled: busy,
          autocomplete: "off",
          "aria-describedby": "mapping-name-hint",
          oninput: (event) => {
            item.name = event.target.value;
            item.dirty = true;
            updateSaveButton(item);
          },
        }),
        el(
          "p",
          { id: "mapping-name-hint", class: "form-text" },
          item.group === "group"
            ? "社团名称优先保留原名。存在同组同名标签时会直接复用。"
            : "创建通用标签后立即建立当前来源标签的映射。存在同组同名标签时直接复用。",
        ),
      ]),
    );
  }
  area.append(
    el("div", { class: "editor-actions" }, [
      el("small", {}, "映射保存后自动进入下一项"),
      button(
        item.status === "saving"
          ? "正在保存…"
          : item.mode === "create"
            ? "创建并映射，下一项 →"
            : "采用并处理下一项 →",
        () => saveMapping(item),
        "btn btn-primary",
        { id: "save-mapping", disabled: !saveAllowed(item) },
      ),
    ]),
  );
  node.append(area);
}
function saveAllowed(item) {
  return (
    !state.pendingWrites &&
    !item.candidatesLoading &&
    ["unresolved", "recommended"].includes(item.status) &&
    (item.mode === "create"
      ? state.groups.includes(item.group) && !!item.name.trim()
      : !!item.selected)
  );
}
function updateSaveButton(item) {
  if ($("save-mapping")) $("save-mapping").disabled = !saveAllowed(item);
}
function candidateNode(candidate, item, disabled) {
  const { generic, evidence } = candidate;
  const selected =
    item.selected && genericKey(item.selected) === genericKey(generic);
  const radio = el("input", {
    type: "radio",
    name: "mapping-candidate",
    checked: selected,
    disabled,
    onchange: () => {
      item.selected = generic;
      item.group = generic.tag_group;
      item.dirty = true;
      renderEditor();
    },
  });
  const node = el(
    "div",
    { class: `candidate${selected ? " selected" : ""}` },
    el("label", { class: "candidate-choice" }, [
      radio,
      el("div", {}, [
        el("div", { class: "candidate-name" }, generic.name),
        el("div", { class: "candidate-group" }, groupLabel(generic.tag_group)),
      ]),
      el(
        "span",
        { class: "candidate-evidence" },
        evidence.length ? `${evidence.length} 条来源证据` : "已有通用标签",
      ),
    ]),
  );
  if (evidence.length)
    node.append(
      el("details", {}, [
        el("summary", {}, "展开来源证据"),
        ...evidence.map((tag) =>
          el("div", { class: "evidence-row" }, [
            el(
              "span",
              {},
              `${tag.site} · ${tag.group || "无来源分组"} · ${tag.tag_sex || "未区分性别"}`,
            ),
            sourceLink(tag.url, tag.site)
              ? el(
                  "a",
                  {
                    href: sourceLink(tag.url, tag.site),
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  tag.url,
                )
              : null,
          ]),
        ),
      ]),
    );
  return node;
}

async function searchGeneric(item, offset = 0) {
  searchController?.abort();
  const controller = (searchController = new AbortController());
  const searchVersion = ++activeSearchVersion;
  const version = routeVersion;
  if (!item.group) {
    item.searchResults = [];
    item.searchTotal = 0;
    item.searchLoading = false;
    renderEditor();
    return;
  }
  const group = item.group,
    name = item.searchText;
  item.searchLoading = true;
  item.searchError = null;
  item.searchOffset = offset;
  item.selected = null;
  renderEditor();
  try {
    const response = await query(
      "/tags/generic/query",
      { tag_group: group, name, name_match: "contains", limit: 10, offset },
      controller.signal,
    );
    const results = await mapLimit(
      response.data,
      6,
      async (id) =>
        (await api(`/tags/generic/${id}`, { signal: controller.signal })).data,
    );
    if (version !== routeVersion || searchVersion !== activeSearchVersion)
      return;
    item.searchResults = results;
    item.searchTotal = Number(response.headers.get("X-Total-Count"));
  } catch (error) {
    if (
      !controller.signal.aborted &&
      version === routeVersion &&
      searchVersion === activeSearchVersion
    )
      item.searchError = error;
  } finally {
    if (version === routeVersion && searchVersion === activeSearchVersion) {
      item.searchLoading = false;
      if (state.active === item.key && item.mode === "search") renderEditor();
    }
  }
}

async function saveMapping(item) {
  if (!saveAllowed(item)) return;
  const target =
    item.mode === "create"
      ? { tag_group: item.group, name: item.name.trim() }
      : item.selected;
  state.pendingWrites++;
  item.status = "saving";
  item.error = null;
  renderEntry();
  let saved = false;
  try {
    let id;
    if (item.mode === "create") {
      const generic = await ensureGeneric(target);
      id = generic.id;
      if (generic.created) state.createdGeneric.add(genericKey(target));
    } else {
      id = await exactGeneric(target);
      if (id === null)
        throw new ApiError(
          "选中的通用标签已不存在，请重新查询。",
          "GENERIC_TAG_NOT_FOUND",
        );
    }
    try {
      const response = await query("/tags/specific", {
        specific_tag: item.tag,
        generic_tag_id: id,
      });
      if (response.status === 201) state.createdSpecific.add(item.key);
      item.tag = response.data;
    } catch (error) {
      if (error.code !== "SPECIFIC_TAG_MAPPING_CONFLICT") throw error;
    }
    const actual = await exactMapping(item.tag);
    if (!actual) throw new ApiError("映射保存后暂时无法读取，请重试查询。");
    if (genericKey(actual.generic) !== genericKey(target)) {
      item.conflict = { wanted: target, actual };
      throw new ApiError(
        "该来源标签已被映射到其他通用标签，请确认现有映射。",
        "SPECIFIC_TAG_MAPPING_CONFLICT",
      );
    }
    item.mapping = actual;
    item.status = "resolved";
    item.dirty = false;
    saved = true;
    // 同原名的未处理变体下次进入时重新读取候选。
    for (const other of state.items)
      if (
        other !== item &&
        other.tag.site === item.tag.site &&
        other.tag.origin_name === item.tag.origin_name
      )
        other.candidatesLoaded = false;
  } catch (error) {
    item.status = "error";
    item.error = error;
  } finally {
    state.pendingWrites--;
    renderEntry();
  }
  if (saved) {
    announce(`${item.tag.origin_name} 已映射到 ${target.name}`);
    nextItem();
  }
}

function reviewGroups() {
  const genericTags = new Map();
  for (const item of state.items)
    if (item.mapping)
      genericTags.set(genericKey(item.mapping.generic), item.mapping.generic);
  return state.groups
    .filter((group) =>
      [...genericTags.values()].some((tag) => tag.tag_group === group),
    )
    .map((group) =>
      el("div", { class: "review-group" }, [
        el("h3", {}, groupLabel(group)),
        el(
          "div",
          { class: "tag-chips" },
          [...genericTags.values()]
            .filter((tag) => tag.tag_group === group)
            .map((tag) =>
              el("span", { class: "tag-chip" }, [
                tag.name,
                state.createdGeneric.has(genericKey(tag))
                  ? el("small", {}, "本次新增")
                  : null,
              ]),
            ),
        ),
      ]),
    );
}
function renderReview() {
  $("review-panel").replaceChildren(
    el("div", { class: "section-heading review-heading" }, [
      el("div", {}, [
        el("h2", {}, state.existingComic ? "确认更新漫画" : "最后确认一下。"),
        el(
          "p",
          {},
          state.existingComic
            ? "将用当前归档替换 CM 中的漫画信息、作者和标签关联。请确认以下分类。"
            : "来源标签已经完成映射，确认以下分类后即可录入漫画。",
        ),
      ]),
      button(
        "← 返回标签整理",
        () => {
          state.phase = "resolving";
          renderEntry();
        },
        "btn btn-sm btn-outline-secondary",
        { disabled: state.phase === "committing" },
      ),
    ]),
    ...(state.existingComic
      ? [
          el("p", { class: "review-stats" }, [
            "CM 更新时间：",
            timeNode(state.existingComic.updated_at),
            " · DMB 更新时间：",
            timeNode(state.source?.updated_at),
          ]),
        ]
      : []),
    el(
      "p",
      { class: "review-stats" },
      `${state.items.length} 个独立来源标签 · 本次新建 ${state.createdGeneric.size} 个通用标签、${state.createdSpecific.size} 条来源映射`,
    ),
    ...(state.items.length
      ? reviewGroups()
      : [empty("无需整理标签", "这部漫画的来源数据没有标签，可以直接录入。")]),
  );
}
function renderResult() {
  const success = state.phase === "success";
  $("result-panel").replaceChildren(
    el(
      "div",
      { class: "result-icon", "aria-hidden": "true" },
      success ? "✓" : "ℹ",
    ),
    el(
      "h2",
      {},
      success
        ? state.existingComic
          ? "漫画已更新"
          : "已收进漫画库"
        : "这部漫画已经录入",
    ),
    el(
      "p",
      {},
      success
        ? `DMB #${state.comicId} 的漫画与标签关联已保存。`
        : "本次没有覆盖已有漫画。可以返回继续整理其他归档。",
    ),
    el("div", { class: "result-actions" }, [
      el(
        "a",
        { href: "#/entry", class: "btn btn-primary" },
        pending.refreshIds.size
          ? "刷新队列并继续 →"
          : nextEntry()
            ? nextEntry().id === state.comicId
              ? "继续处理当前部 →"
              : "处理下一部 →"
            : "返回待处理队列 →",
      ),
      el(
        "a",
        {
          href: `#/read/${state.comicId}?back=${encodeURIComponent(state.lastLibraryHash)}`,
          class: "btn btn-outline-secondary",
        },
        "阅读漫画",
      ),
      button(
        "查看本次标签",
        () => {
          $("result-tags").hidden = !$("result-tags").hidden;
        },
        "btn btn-outline-secondary",
      ),
      button("查看来源数据", showMetadata, "btn btn-quiet"),
    ]),
    el(
      "div",
      { id: "result-tags", hidden: true, class: "mt-4" },
      reviewGroups(),
    ),
    ...(success ? [rawDetails("查看已提交的漫画数据", state.result)] : []),
  );
}
function renderEntry(editor = true) {
  if (state.view !== "entry") return;
  renderSummary();
  renderQueue();
  const finished = ["success", "already-exists"].includes(state.phase);
  const reviewing = ["review", "committing"].includes(state.phase);
  $("workspace").hidden = finished || reviewing;
  $("review-panel").hidden = !reviewing;
  $("result-panel").hidden = !finished;
  $("entry-footer").hidden = finished;
  $("step-tags").className = !reviewing && !finished ? "active" : "complete";
  $("step-review").className = reviewing || finished ? "active" : "";
  $("settings-open").disabled =
    state.pendingWrites > 0 || state.phase === "committing";
  if (reviewing) renderReview();
  else if (finished) renderResult();
  else if (editor) renderEditor();
  $("review-button").disabled = !canCommit();
  $("review-button").textContent =
    state.phase === "committing"
      ? "正在录入…"
      : reviewing
        ? state.existingComic
          ? "确认更新漫画"
          : "确认录入漫画"
        : state.existingComic
          ? "复核并更新 →"
          : "复核并录入 →";
  $("footer-hint").textContent = state.pendingWrites
    ? "正在保存，请稍候"
    : unresolved().length
      ? `还有 ${unresolved().length} 个标签待处理`
      : state.existingComic
        ? "全部标签已映射，可以更新"
        : "全部标签已映射，可以录入";
}

async function commitComic() {
  if (!canCommit()) return;
  state.phase = "committing";
  state.pendingWrites++;
  state.message = null;
  renderMessage();
  renderEntry();
  let missing = null;
  pending.refreshIds.add(state.comicId);
  try {
    const { data } = await api(
      `/comics/${state.comicId}/commit${state.existingComic ? "?allow_override=true" : ""}`,
      { method: "POST" },
    );
    state.result = data;
    state.phase = "success";
    browserPage.clear();
    try {
      const persisted = await readEntryCompletion(dmbUrl, state.comicId);
      pending.comics.set(state.comicId, persisted.comic);
      pending.documents.set(state.comicId, persisted.document);
      updatePendingComparison();
      pending.refreshIds.delete(state.comicId);
      if (completionReason(persisted.document, persisted.comic) !== null)
        message(
          "漫画已保存，但 CM 更新时间尚未晚于 DMB，仍保留在待处理队列中。",
          "warning",
        );
    } catch (error) {
      message(
        "漫画已保存，队列状态确认失败；继续前会重新核对这部漫画。",
        "warning",
        error,
      );
    }
    announce("漫画录入成功。");
  } catch (error) {
    if (error.code === "COMIC_ALREADY_EXISTS") {
      state.phase = "already-exists";
    } else if (error.code === "UNMAPPED_SPECIFIC_TAGS") {
      missing = error.details.specific_tags || [];
      state.phase = "resolving";
      message("部分映射已失效，正在重新查询，请确认后再录入。");
    } else {
      state.phase = "review";
      message(error.message, "danger", error, commitComic);
    }
  } finally {
    state.pendingWrites--;
    renderEntry();
  }
  if (missing) {
    const affected = state.items.filter((item) =>
      missing.some((tag) => stableKey(tag) === item.key),
    );
    if (affected.length !== missing.length)
      await loadEntry(
        state.comicId,
        ++routeVersion,
        "来源标签已变化，已重新读取预览。",
        true,
      );
    else {
      state.active = affected[0]?.key || state.active;
      for (const item of affected) {
        item.mapping = null;
        item.candidatesLoaded = false;
      }
      await mapLimit(affected, 6, (item) => resolveItem(item));
    }
  }
}
function showMetadata() {
  $("metadata-content").replaceChildren(
    state.source
      ? rawDetails("DMB 归档记录", state.source, true)
      : el(
          "p",
          { class: "text-secondary" },
          "来源详情未加载，可关闭窗口后重试读取。",
        ),
    rawDetails("Comic 预览", state.preview, !state.source),
  );
  $("metadata-dialog").showModal();
}

async function loadLibrary(offset = 0) {
  libraryController?.abort();
  const controller = (libraryController = new AbortController());
  const group = $("library-group").value;
  if (!group) return;
  $("library-detail").hidden = true;
  libraryDetailController?.abort();
  $("library-results").replaceChildren(
    el("p", { class: "text-secondary p-4" }, "正在查询标签…"),
  );
  $("library-pagination").replaceChildren();
  try {
    const response = await query(
      "/tags/generic/query",
      {
        tag_group: group,
        name: $("library-search").value,
        name_match: "contains",
        limit: 20,
        offset,
      },
      controller.signal,
    );
    const records = await mapLimit(response.data, 6, async (id) => ({
      id,
      tag: (await api(`/tags/generic/${id}`, { signal: controller.signal }))
        .data,
    }));
    if (controller.signal.aborted) return;
    $("library-results").replaceChildren(
      ...(records.length
        ? records.map(({ id, tag }) =>
            el("div", { class: "library-row" }, [
              el("small", {}, `#${id}`),
              el("div", {}, [
                el("strong", {}, tag.name),
                el("small", { class: "d-block" }, groupLabel(tag.tag_group)),
              ]),
              button(
                "查看映射 →",
                () => showGeneric(id),
                "btn btn-sm btn-quiet",
                { "aria-label": `查看 ${tag.name} 的来源映射` },
              ),
            ]),
          )
        : [
            empty(
              "当前分类下没有匹配标签",
              "调整搜索条件，或新建一个通用标签。",
            ),
          ]),
    );
    const total = Number(response.headers.get("X-Total-Count"));
    $("library-pagination").replaceChildren(
      el("span", {}, `共 ${total} 项`),
      button("上一页", () => loadLibrary(offset - 20), "btn btn-sm btn-quiet", {
        disabled: offset === 0,
      }),
      button("下一页", () => loadLibrary(offset + 20), "btn btn-sm btn-quiet", {
        disabled: offset + 20 >= total,
      }),
    );
  } catch (error) {
    if (!controller.signal.aborted)
      $("library-results").replaceChildren(
        errorBox(error, () => loadLibrary(offset)),
      );
  }
}
async function showGeneric(id, offset = 0) {
  libraryDetailController?.abort();
  const controller = (libraryDetailController = new AbortController());
  const node = $("library-detail");
  node.hidden = false;
  node.replaceChildren(el("p", {}, "正在读取来源映射…"));
  try {
    const { data: generic } = await api(`/tags/generic/${id}`, {
      signal: controller.signal,
    });
    const response = await api(
      `/tags/generic/${id}/specifics?limit=20&offset=${offset}`,
      { signal: controller.signal },
    );
    const tags = await mapLimit(
      response.data,
      6,
      async (id) =>
        (await api(`/tags/specific/${id}`, { signal: controller.signal })).data,
    );
    if (controller.signal.aborted) return;
    node.replaceChildren(
      el("div", { class: "section-heading" }, [
        el("div", {}, [
          el("h2", {}, generic.name),
          el(
            "p",
            {},
            `${groupLabel(generic.tag_group)} · ${response.headers.get("X-Total-Count")} 条来源映射`,
          ),
        ]),
        button(
          "收起",
          () => {
            node.hidden = true;
          },
          "btn btn-sm btn-quiet",
        ),
      ]),
      ...(tags.length
        ? tags.map((tag) =>
            el("div", { class: "source-card" }, [
              el("strong", {}, tag.origin_name),
              metadataFields(tag),
              rawDetails("完整来源标签", tag),
            ]),
          )
        : [empty("尚无来源标签映射")]),
      el("div", { class: "pagination-bar" }, [
        button(
          "上一页",
          () => showGeneric(id, offset - 20),
          "btn btn-sm btn-quiet",
          { disabled: offset === 0 },
        ),
        button(
          "下一页",
          () => showGeneric(id, offset + 20),
          "btn btn-sm btn-quiet",
          {
            disabled:
              offset + 20 >= Number(response.headers.get("X-Total-Count")),
          },
        ),
      ]),
    );
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (!controller.signal.aborted)
      node.replaceChildren(errorBox(error, () => showGeneric(id, offset)));
  }
}

$("pending-refresh").addEventListener("click", () =>
  scanPending(false, "anchor"),
);
$("pending-full-scan").addEventListener("click", () =>
  scanPending(false, "full"),
);
$("batch-entry-start").addEventListener("click", startBatchEntry);
$("batch-entry-stop").addEventListener("click", () => {
  batchEntry.stopRequested = true;
  renderBatchEntry();
});
$("pending-cancel").addEventListener("click", () =>
  pending.controller?.abort(),
);
for (const [key, label] of Object.entries(PENDING_REASONS))
  $("pending-reason").append(el("option", { value: key }, label));
for (const [key, label] of Object.entries({
  ...DMB_STATUSES,
  missing_source: "来源缺失",
}))
  if (isQueueDocument({ status: key }))
    $("pending-status").append(el("option", { value: key }, label));
for (const name of ["search", "reason", "status"])
  $("pending-" + name).addEventListener(
    name === "search" ? "input" : "change",
    (event) => {
      pending[name] = event.target.value;
      pending.offset = 0;
      renderPending();
    },
  );
$("queue-search").addEventListener("input", (event) => {
  state.queueSearch = event.target.value;
  renderQueue();
});
$("queue-status").addEventListener("change", (event) => {
  state.queueStatus = event.target.value;
  renderQueue();
});
$("queue-group").addEventListener("change", (event) => {
  state.queueGroup = event.target.value;
  renderQueue();
});
$("review-button").addEventListener("click", () => {
  if (!canCommit()) return;
  if (state.phase === "review") void commitComic();
  else {
    state.phase = "review";
    renderEntry();
  }
});
$("metadata-open").addEventListener("click", showMetadata);
$("settings-open").addEventListener("click", () => {
  $("dmb-url").value = dmbUrl;
  $("image-route-" + imageRoute).checked = true;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
});
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const value = validateDmbUrl($("dmb-url").value.trim());
    const nextImageRoute = $("image-route-direct").checked ? "direct" : "proxy";
    const serviceChanged = value !== dmbUrl;
    const imageRouteChanged = nextImageRoute !== imageRoute;
    if (
      serviceChanged &&
      dirty() &&
      !confirm("更换归档服务会清除当前未保存的选择，是否继续？")
    )
      return;
    localStorage.setItem("comicmanager.dmbUrl", value);
    localStorage.setItem("comicmanager.imageRoute", nextImageRoute);
    dmbUrl = value;
    imageRoute = nextImageRoute;
    $("settings-dialog").close();
    if (serviceChanged) {
      pending.controller?.abort();
      pending.documents = pending.comics = pending.comparison = null;
      pending.mode = "anchor";
      pending.cmMinId = 0;
      pending.cmTotal = null;
      pending.anchor = pending.scannedAt = null;
      restoreEntryQueue();
      pending.phase = "idle";
      pending.refreshIds.clear();
      for (const item of state.items) item.dirty = false;
      void route();
    } else if (imageRouteChanged) {
      if (state.view === "browse") void browserPage.refreshImages();
      if (state.view === "reader") reader.refreshImage();
      announce(
        `图片线路已切换为${imageRoute === "direct" ? "8880 直连" : "代理"}。`,
      );
    }
  } catch (error) {
    $("settings-error").textContent = error.message;
  }
});
for (const close of document.querySelectorAll("[data-close-dialog]"))
  close.addEventListener("click", () => close.closest("dialog").close());
$("library-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadLibrary();
});
$("library-group").addEventListener("change", () => loadLibrary());
let librarySearchTimer;
$("library-search").addEventListener("input", () => {
  libraryController?.abort();
  clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(() => loadLibrary(), 300);
});
$("library-create-open").addEventListener("click", async () => {
  try {
    await loadGroups(pageController.signal);
    options($("new-tag-group"), $("library-group").value || "", true);
    $("new-tag-name").value = "";
    $("new-tag-error").textContent = "";
    $("new-tag-dialog").showModal();
  } catch (error) {
    message(error.message, "danger", error);
  }
});
$("new-tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pendingWrites) return;
  const tag = {
    tag_group: $("new-tag-group").value,
    name: $("new-tag-name").value.trim(),
  };
  if (!state.groups.includes(tag.tag_group) || !tag.name) {
    $("new-tag-error").textContent = "请选择分类并填写名称。";
    return;
  }
  state.pendingWrites++;
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const result = await ensureGeneric(tag);
    $("new-tag-dialog").close();
    $("library-group").value = tag.tag_group;
    $("library-search").value = tag.name;
    message(
      result.created ? "通用标签已创建。" : "同组同名标签已存在，已为你定位。",
      "success",
    );
    await loadLibrary();
  } catch (error) {
    $("new-tag-error").textContent = error.message;
  } finally {
    state.pendingWrites--;
    submit.disabled = false;
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.pendingWrites || dirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
const browserPage = createLibraryPage({
  el,
  button,
  empty,
  errorBox,
  getDmbUrl: () => dmbUrl,
  getImageRoute: () => imageRoute,
  setService,
  announce,
  refreshRoute: route,
});
const reader = createComicReader({
  el,
  button,
  empty,
  errorBox,
  getDmbUrl: () => dmbUrl,
  getImageRoute: () => imageRoute,
  setService,
  announce,
});
const downloadPage = createDownloadPage({
  el,
  empty,
  getDmbUrl: () => dmbUrl,
  setService,
});
window.addEventListener("pagehide", () => pageController.abort());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void route();
});
window.addEventListener("hashchange", route);
void route();

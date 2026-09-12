import { ApiError, dmb, GROUP_NAMES, stableKey } from "./entry-api.js";
import { readComic, DMB_STATUSES } from "./pending-comics.js?v=queue-status-1";
import {
  documentPages,
  pageImageUrl,
  libraryReturn,
  parseLibraryHash,
  libraryHash,
  resolveLibraryTags,
} from "./comic-library.js";
import { viewerLink } from "./comic-links.js?v=comic-detail-1";

export function createComicDetail({
  el,
  button,
  empty,
  errorBox,
  getDmbUrl,
  getImageRoute,
  getViewerUrl,
  setService,
}) {
  const root = document.getElementById("comic-detail-page");
  let active;
  const current = (entry) => active === entry && !entry.signal.aborted;
  const raw = (label, data) =>
    el("details", { class: "raw-details" }, [
      el("summary", {}, label),
      el("pre", {}, JSON.stringify(data, null, 2)),
    ]);
  const facts = (values) =>
    el(
      "dl",
      { class: "comic-detail-facts" },
      values.map(([label, value]) => [
        el("dt", {}, label),
        el("dd", {}, value ?? "—"),
      ]),
    );
  const time = (value) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime())
      ? el(
          "time",
          { datetime: value, title: value },
          date.toLocaleString("zh-CN", { hour12: false }),
        )
      : value || "—";
  };

  function refreshViewer() {
    if (!active?.comic || !current(active)) return;
    active.viewer.href = viewerLink(
      getViewerUrl(),
      active.comic.id,
      location.href,
    );
  }

  function coverMessage(entry, text, retry) {
    entry.cover.replaceChildren(
      el("span", { class: "cover-placeholder" }, text),
      ...(retry
        ? [button("重试封面", retry, "btn btn-sm btn-outline-secondary")]
        : []),
    );
  }

  async function loadCover(entry) {
    entry.coverController?.abort();
    if (!current(entry) || !entry.source) return;
    const controller = (entry.coverController = new AbortController());
    const signal = AbortSignal.any([entry.signal, controller.signal]);
    const pages = documentPages(entry.source);
    if (!pages.length) {
      coverMessage(entry, "暂无封面");
      return;
    }
    coverMessage(entry, "正在加载封面…");
    try {
      const src = await pageImageUrl(
        getDmbUrl(),
        entry.comic.id,
        pages[0].index,
        getImageRoute(),
        signal,
      );
      if (!current(entry) || signal.aborted) return;
      const image = el("img", {
        alt: `${entry.comic.title} 封面`,
        decoding: "async",
        referrerpolicy: "no-referrer",
        onerror: () => {
          if (current(entry) && !signal.aborted)
            coverMessage(entry, "封面暂不可用", () => loadCover(entry));
        },
      });
      signal.addEventListener("abort", () => image.removeAttribute("src"), {
        once: true,
      });
      image.src = src;
      entry.cover.replaceChildren(image);
    } catch (error) {
      if (current(entry) && !signal.aborted)
        coverMessage(entry, "封面暂不可用", () => loadCover(entry));
    }
  }

  async function loadSource(entry) {
    entry.sourceController?.abort();
    const controller = (entry.sourceController = new AbortController());
    const signal = AbortSignal.any([entry.signal, controller.signal]);
    entry.archive.replaceChildren(
      el("p", { class: "text-secondary" }, "正在读取来源归档…"),
    );
    try {
      const { data } = await dmb(
        getDmbUrl(),
        `/v1/documents/${entry.comic.id}`,
        { signal },
      );
      if (!current(entry) || signal.aborted) return;
      if (data?.document_id !== entry.comic.id)
        throw new ApiError("DMB 返回了其他漫画的记录。", "INVALID_RESPONSE");
      entry.source = data;
      setService(true);
      const pages = documentPages(data);
      entry.archive.replaceChildren(
        facts([
          ["来源站点", data.source],
          ["来源 ID", data.source_document_id],
          ["归档标题", data.title],
          ["归档状态", DMB_STATUSES[data.status] || data.status],
          ["页面数量", `${pages.length} 页`],
          ["存储", data.storage_backend],
          ["归档创建时间", time(data.created_at)],
          ["归档更新时间", time(data.updated_at)],
        ]),
        ...(data.error ? [el("p", { class: "text-danger" }, data.error)] : []),
        raw("DMB 原始数据", data),
      );
      await loadCover(entry);
    } catch (error) {
      if (!current(entry) || signal.aborted) return;
      if (!error.status || error.status >= 500) setService(false);
      coverMessage(entry, "来源暂不可用");
      entry.archive.replaceChildren(
        errorBox(
          error,
          () => loadSource(entry),
          "来源归档暂不可用，已保留 CM 元数据。",
        ),
      );
    }
  }

  async function loadTags(entry) {
    entry.tagController?.abort();
    const controller = (entry.tagController = new AbortController());
    const signal = AbortSignal.any([entry.signal, controller.signal]);
    const mappings = await resolveLibraryTags([entry.comic], signal);
    if (!current(entry) || signal.aborted) return;
    const resolved = new Map();
    const unresolved = [];
    for (const tag of entry.comic.comic_tags) {
      const result = mappings.get(stableKey(tag));
      if (result?.id) resolved.set(result.id, result);
      else unresolved.push(tag);
    }
    const groups = new Map();
    for (const value of resolved.values()) {
      const group = value.tag.tag_group;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(value);
    }
    entry.tags.replaceChildren(
      ...[...groups].map(([group, values]) =>
        el("div", { class: "comic-detail-tag-group" }, [
          el("h3", {}, GROUP_NAMES[group] || group),
          el(
            "div",
            { class: "tag-chips" },
            values.map(({ id, tag }) =>
              el(
                "a",
                {
                  class: "comic-tag",
                  href: libraryHash({
                    ...entry.filters,
                    generic_tag_ids: [
                      ...new Set([...entry.filters.generic_tag_ids, id]),
                    ],
                    page: 1,
                  }),
                },
                tag.name,
              ),
            ),
          ),
        ]),
      ),
    );
    if (unresolved.length)
      entry.tags.append(
        el(
          "p",
          { class: "text-secondary" },
          "以下来源标签的通用映射暂不可用：",
        ),
        el(
          "div",
          { class: "tag-chips" },
          unresolved.map((tag) =>
            el("span", { class: "comic-tag" }, tag.origin_name),
          ),
        ),
        button(
          "重试标签",
          () => void loadTags(entry).catch(() => {}),
          "btn btn-sm btn-quiet",
        ),
      );
    if (!entry.comic.comic_tags.length)
      entry.tags.append(el("p", { class: "text-secondary" }, "暂无标签"));
    if (entry.comic.comic_tags.length)
      entry.tags.append(raw("来源标签原始数据", entry.comic.comic_tags));
  }

  async function show(id, params, signal) {
    const back = libraryReturn(params.get("back"));
    const entry = {
      signal,
      comic: null,
      source: null,
      filters: parseLibraryHash(back),
    };
    active = entry;
    const backlink = el(
      "a",
      { href: back, class: "back-link" },
      "← 返回漫画库",
    );
    root.replaceChildren(backlink, empty("正在读取漫画详情…"));
    try {
      const comic = await readComic(id, { signal });
      if (!current(entry)) return;
      if (!comic)
        throw new ApiError(
          "这部漫画不在 CM 库中。",
          "COMIC_NOT_FOUND",
          {},
          404,
        );
      entry.comic = comic;
      document.title = `${comic.title} · 漫画详情`;
      entry.cover = el("div", { class: "comic-detail-cover" });
      coverMessage(entry, "正在加载封面…");
      entry.viewer = el(
        "a",
        { class: "btn btn-primary", referrerpolicy: "no-referrer" },
        "阅览",
      );
      refreshViewer();
      entry.tags = el(
        "div",
        {},
        el("p", { class: "text-secondary" }, "正在读取标签…"),
      );
      entry.archive = el("div");
      root.replaceChildren(
        backlink,
        el("div", { class: "comic-detail-layout" }, [
          entry.cover,
          el("div", { class: "comic-detail-summary" }, [
            el("p", { class: "comic-detail-id" }, `DMB #${comic.id}`),
            el("h1", {}, comic.title || "未命名漫画"),
            el(
              "div",
              { class: "comic-authors" },
              comic.authors.length
                ? comic.authors.map((author) =>
                    el(
                      "a",
                      {
                        href: libraryHash({
                          ...entry.filters,
                          author_name: author,
                          author_match: "exact",
                          page: 1,
                        }),
                      },
                      author,
                    ),
                  )
                : "作者未提供",
            ),
            entry.viewer,
            facts([
              ["漫画 ID", String(comic.id)],
              ["系列", comic.series_name],
              ["卷号", comic.volume_number],
              ["CM 更新时间", time(comic.updated_at)],
            ]),
          ]),
        ]),
        el(
          "section",
          { class: "comic-detail-section", "aria-label": "漫画标签" },
          [el("h2", {}, "标签"), entry.tags],
        ),
        el(
          "section",
          { class: "comic-detail-section", "aria-label": "来源归档" },
          [el("h2", {}, "来源归档"), entry.archive],
        ),
        raw("CM 原始数据", comic),
      );
      await Promise.allSettled([loadSource(entry), loadTags(entry)]);
    } catch (error) {
      if (current(entry))
        root.replaceChildren(
          backlink,
          errorBox(error, () => show(id, params, signal)),
        );
    }
  }

  return {
    show,
    refreshViewer,
    refreshImages: () =>
      active && current(active) ? loadCover(active) : undefined,
  };
}

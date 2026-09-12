import { api, dmb, GROUP_NAMES, mapLimit, stableKey } from "./entry-api.js";
import {
  PAGE_SIZES,
  parseLibraryHash,
  libraryHash,
  queryComics,
  resolveLibraryTags,
  searchLibraryTags,
  documentPages,
  pageImageUrl,
} from "./comic-library.js?v=id-desc-1";
import { comicDetailLink } from "./comic-links.js?v=comic-detail-1";

export function createLibraryPage({
  el,
  button,
  empty,
  errorBox,
  getDmbUrl,
  getImageRoute,
  setService,
  announce,
  refreshRoute,
}) {
  const $ = (id) => document.getElementById(id);
  let filters = parseLibraryHash();
  let selected = [];
  let groups = [];
  let signal;
  let searchController;
  let searchTimer;
  let suggestions = [];
  let activeSuggestion = -1;
  let cards = new Map();
  let coverController;
  const records = new Map();
  const tagNames = new Map();
  const matchNames = { exact: "精确", prefix: "前缀", contains: "包含" };

  function navigate(next) {
    const hash = libraryHash(next);
    if ((location.hash || "#/") === hash) void refreshRoute();
    else location.hash = hash;
  }
  function draft() {
    return {
      ...filters,
      page: 1,
      title: $("browse-title").value,
      author_name: $("browse-author").value,
      title_match: $("browse-title-match").value,
      author_match: $("browse-author-match").value,
      generic_tag_ids: [...selected],
      tag_match: $("browse-tag-match").value,
    };
  }
  function closeSuggestions() {
    $("browse-tag-popup").hidden = true;
    $("browse-tag-input").setAttribute("aria-expanded", "false");
    $("browse-tag-input").removeAttribute("aria-activedescendant");
    activeSuggestion = -1;
  }
  function renderSelected() {
    $("browse-selected-tags").replaceChildren(
      ...selected.map((id) => {
        const tag = tagNames.get(id);
        return el("span", { class: "selected-tag" }, [
          el("span", {}, tag?.name || `标签 #${id}`),
          tag
            ? el("small", {}, GROUP_NAMES[tag.tag_group] || tag.tag_group)
            : null,
          button(
            "×",
            () => {
              selected = selected.filter((value) => value !== id);
              renderSelected();
              $("browse-tag-input").focus();
              if ($("browse-tag-input").value.trim()) void findSuggestions();
            },
            "tag-remove",
            { "aria-label": `移除标签 ${tag?.name || id}` },
          ),
        ]);
      }),
    );
    $("browse-tag-mode").hidden = selected.length < 2;
    $("browse-tag-input").placeholder = selected.length
      ? "继续添加标签…"
      : "输入文字，选择标签后继续添加…";
  }
  function chooseSuggestion(item) {
    if (selected.includes(item.id)) return;
    if (selected.length >= 100) {
      $("browse-tag-hint").textContent = "最多选择 100 个标签。";
      return;
    }
    selected.push(item.id);
    tagNames.set(item.id, item.tag);
    searchController?.abort();
    clearTimeout(searchTimer);
    $("browse-tag-input").value = "";
    $("browse-tag-input").setCustomValidity("");
    closeSuggestions();
    renderSelected();
    $("browse-tag-input").focus();
    announce(`已选择标签 ${item.tag.name}，可继续输入，完成后点击检索。`);
  }
  function highlightSuggestion(index) {
    activeSuggestion = index;
    const nodes = $("browse-tag-suggestions").children;
    for (let i = 0; i < nodes.length; i++)
      nodes[i].setAttribute("aria-selected", String(i === index));
    if (nodes[index]) {
      $("browse-tag-input").setAttribute(
        "aria-activedescendant",
        nodes[index].id,
      );
      nodes[index].scrollIntoView({ block: "nearest" });
    }
  }
  async function findSuggestions() {
    searchController?.abort();
    closeSuggestions();
    const name = $("browse-tag-input").value;
    if (
      !name.trim() ||
      signal?.aborted ||
      document.activeElement !== $("browse-tag-input")
    )
      return;
    const controller = (searchController = new AbortController());
    const searchSignal = AbortSignal.any([signal, controller.signal]);
    suggestions = [];
    $("browse-tag-popup").hidden = false;
    $("browse-tag-input").setAttribute("aria-expanded", "true");
    $("browse-tag-suggestions").replaceChildren();
    $("browse-tag-hint").textContent = "正在查找标签…";
    try {
      if (!groups.length)
        groups = (await api("/tags/groups", { signal: searchSignal })).data;
      const result = await searchLibraryTags(groups, name, searchSignal);
      if (searchSignal.aborted) return;
      suggestions = result.tags.filter((item) => !selected.includes(item.id));
      $("browse-tag-suggestions").replaceChildren(
        ...suggestions.map((item, index) =>
          el(
            "div",
            {
              id: `tag-suggestion-${index}`,
              role: "option",
              "aria-selected": "false",
              class: "tag-suggestion",
              onmousedown: (event) => event.preventDefault(),
              onclick: () => chooseSuggestion(item),
            },
            [
              el("span", {}, item.tag.name),
              el(
                "small",
                {},
                GROUP_NAMES[item.tag.tag_group] || item.tag.tag_group,
              ),
            ],
          ),
        ),
      );
      $("browse-tag-hint").textContent = suggestions.length
        ? result.total > result.tags.length
          ? `共 ${result.total} 个匹配，显示各分类前 12 项，可继续输入缩小范围。`
          : "↑ ↓ 选择 · Enter 添加 · 可连续添加多个标签"
        : result.total
          ? "匹配的标签已选中，可继续输入其他名称。"
          : "没有包含这些文字的标签。";
    } catch (error) {
      if (!searchSignal.aborted)
        $("browse-tag-hint").replaceChildren(
          el("span", {}, error.message),
          button("重试", findSuggestions, "btn btn-sm btn-quiet"),
        );
    }
  }

  $("browse-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("browse-tag-input").value.trim()) {
      $("browse-tag-input").setCustomValidity(
        "请从提示中选择标签，或清空未选中的文字。",
      );
      $("browse-tag-input").reportValidity();
      return;
    }
    const value = draft();
    for (const [id, text] of [
      ["browse-title", value.title],
      ["browse-author", value.author_name],
    ]) {
      $(id).setCustomValidity(
        text && !text.trim() ? "请输入有效文字，或清空此条件。" : "",
      );
      if (!$(id).reportValidity()) return;
    }
    navigate(value);
  });
  for (const id of ["browse-title", "browse-author", "browse-tag-input"])
    $(id).addEventListener("input", () => $(id).setCustomValidity(""));
  $("browse-reset").addEventListener("click", () =>
    navigate(parseLibraryHash()),
  );
  $("browse-refresh").addEventListener("click", () => refreshRoute());
  $("browse-tag-box").addEventListener("click", () =>
    $("browse-tag-input").focus(),
  );
  $("browse-tag-input").addEventListener("input", (event) => {
    searchController?.abort();
    clearTimeout(searchTimer);
    closeSuggestions();
    if (!event.isComposing) searchTimer = setTimeout(findSuggestions, 280);
  });
  $("browse-tag-input").addEventListener("compositionend", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(findSuggestions, 280);
  });
  $("browse-tag-input").addEventListener("focus", () => {
    if ($("browse-tag-input").value.trim() && $("browse-tag-popup").hidden)
      void findSuggestions();
  });
  $("browse-tag-input").addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const open = !$("browse-tag-popup").hidden;
    if (
      open &&
      suggestions.length &&
      ["ArrowDown", "ArrowUp"].includes(event.key)
    ) {
      event.preventDefault();
      const index =
        activeSuggestion < 0
          ? event.key === "ArrowDown"
            ? 0
            : suggestions.length - 1
          : (activeSuggestion +
              (event.key === "ArrowDown" ? 1 : -1) +
              suggestions.length) %
            suggestions.length;
      highlightSuggestion(index);
    } else if (open && event.key === "Enter" && suggestions.length) {
      event.preventDefault();
      chooseSuggestion(suggestions[Math.max(0, activeSuggestion)]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
    } else if (
      event.key === "Backspace" &&
      !event.target.value &&
      selected.length
    ) {
      selected.pop();
      renderSelected();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".browse-tag-field")) closeSuggestions();
  });
  $("browse-tag-input").addEventListener("blur", () => {
    clearTimeout(searchTimer);
    searchController?.abort();
    closeSuggestions();
  });
  $("browse-tag-popup").addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });

  function pagination(total, position) {
    const pages = Math.max(1, Math.ceil(total / filters.limit));
    const pageInput = el("input", {
      type: "number",
      class: "form-control form-control-sm",
      min: 1,
      max: pages,
      step: 1,
      required: true,
      value: filters.page,
      disabled: !total,
      "aria-label": `${position}跳转页码`,
    });
    const pageJump = el(
      "form",
      {
        class: "page-jump",
        onsubmit: (event) => {
          event.preventDefault();
          if (pageInput.reportValidity())
            navigate({ ...filters, page: pageInput.valueAsNumber });
        },
      },
      [
        el("span", {}, "跳至"),
        pageInput,
        el("span", {}, "页"),
        el(
          "button",
          {
            type: "submit",
            class: "btn btn-sm btn-outline-secondary",
            disabled: !total,
          },
          "跳转",
        ),
      ],
    );
    const size = el(
      "select",
      {
        class: "form-select form-select-sm",
        "aria-label": `${position}每页数量`,
        onchange: (event) =>
          navigate({ ...filters, limit: Number(event.target.value), page: 1 }),
      },
      PAGE_SIZES.map((value) =>
        el(
          "option",
          { value, selected: value === filters.limit },
          `${value} 部 / 页`,
        ),
      ),
    );
    return [
      el(
        "span",
        { class: "browse-count" },
        `共 ${total} 部 · 第 ${filters.page} / ${pages} 页`,
      ),
      size,
      button(
        "上一页",
        () => navigate({ ...filters, page: filters.page - 1 }),
        "btn btn-sm btn-quiet",
        { disabled: filters.page === 1 },
      ),
      button(
        "下一页",
        () => navigate({ ...filters, page: filters.page + 1 }),
        "btn btn-sm btn-quiet",
        { disabled: filters.page >= pages },
      ),
      pageJump,
    ];
  }

  function card(comic) {
    const cover = el(
      "a",
      {
        href: comicDetailLink(comic.id, libraryHash(filters)),
        class: "comic-cover",
        "aria-label": `查看详情：${comic.title}`,
      },
      el("span", { class: "cover-placeholder" }, "正在加载封面…"),
    );
    const source = el("span", {}, `#${comic.id}`);
    const tagBox = el(
      "div",
      { class: "comic-card-tags" },
      el("small", {}, comic.comic_tags.length ? "正在读取标签…" : "暂无标签"),
    );
    const node = el(
      "article",
      { class: "comic-card", "data-comic-id": comic.id },
      [
        cover,
        el("div", { class: "comic-card-body" }, [
          el("div", { class: "comic-card-meta" }, [source]),
          el(
            "h2",
            {},
            el(
              "a",
              { href: comicDetailLink(comic.id, libraryHash(filters)) },
              comic.title || "未命名漫画",
            ),
          ),
          el(
            "div",
            { class: "comic-authors" },
            comic.authors.length
              ? comic.authors.map((author) =>
                  el(
                    "a",
                    {
                      href: libraryHash({
                        ...filters,
                        author_name: author,
                        author_match: "exact",
                        page: 1,
                      }),
                      title: `检索作者 ${author}`,
                    },
                    author,
                  ),
                )
              : el("span", {}, "作者未提供"),
          ),
          comic.series_name
            ? el(
                "small",
                {},
                `${comic.series_name}${comic.volume_number === null ? "" : ` · 第 ${comic.volume_number} 卷`}`,
              )
            : null,
          tagBox,
        ]),
      ],
    );
    return { node, cover, source, tagBox };
  }
  async function loadCover(comic, elements, requestSignal) {
    let sourceReady = false;
    try {
      const { data } = await dmb(getDmbUrl(), `/v1/documents/${comic.id}`, {
        signal: requestSignal,
      });
      if (requestSignal.aborted) return;
      setService(true);
      const pages = documentPages(data);
      elements.source.textContent = `#${comic.id} · ${pages.length} 页 · ${data.source}`;
      sourceReady = true;
      if (!pages.length) {
        elements.cover.replaceChildren(
          el("span", { class: "cover-placeholder" }, "暂无可读页面"),
        );
        return;
      }
      const src = await pageImageUrl(
        getDmbUrl(),
        comic.id,
        pages[0].index,
        getImageRoute(),
        requestSignal,
      );
      if (requestSignal.aborted) return;
      const image = el("img", {
        src,
        alt: `${comic.title} 封面`,
        loading: "lazy",
        decoding: "async",
        referrerpolicy: "no-referrer",
        onerror: () => {
          if (!requestSignal.aborted)
            elements.cover.replaceChildren(
              el(
                "span",
                { class: "cover-placeholder" },
                "封面暂不可用 · 查看详情",
              ),
            );
        },
      });
      elements.cover.replaceChildren(image);
    } catch (error) {
      if (requestSignal.aborted) return;
      elements.cover.replaceChildren(
        el("span", { class: "cover-placeholder" }, "封面暂不可用"),
      );
      if (sourceReady) {
        elements.source.append(
          button(
            "重试封面",
            () => loadCover(comic, elements, requestSignal),
            "btn btn-sm btn-quiet",
          ),
        );
        return;
      }
      if (!error.status || error.status >= 500) setService(false);
      elements.source.replaceChildren(
        `#${comic.id} · 来源暂不可读 `,
        button(
          "重试",
          () => loadCover(comic, elements, requestSignal),
          "btn btn-sm btn-quiet",
        ),
      );
    }
  }
  async function refreshImages() {
    coverController?.abort();
    if (!signal || signal.aborted) return;
    coverController = new AbortController();
    const requestSignal = AbortSignal.any([signal, coverController.signal]);
    const currentCards = cards;
    await mapLimit([...records.values()], 4, async (comic) => {
      if (requestSignal.aborted) return;
      const elements = currentCards.get(comic.id);
      elements.cover.replaceChildren(
        el("span", { class: "cover-placeholder" }, "正在加载封面…"),
      );
      await loadCover(comic, elements, requestSignal);
    });
  }
  async function loadTags(comics, cards, requestSignal) {
    const mappings = await resolveLibraryTags(comics, requestSignal);
    if (requestSignal.aborted) return;
    for (const comic of comics) {
      const values = comic.comic_tags.map((tag) =>
        mappings.get(stableKey(tag)),
      );
      const resolved = [
        ...new Map(
          values.filter((value) => value?.id).map((value) => [value.id, value]),
        ).values(),
      ];
      const chips = resolved.map(({ id, tag }) =>
        el(
          "a",
          {
            class: "comic-tag",
            title: GROUP_NAMES[tag.tag_group] || tag.tag_group,
            href: libraryHash({
              ...filters,
              page: 1,
              generic_tag_ids: [...new Set([...filters.generic_tag_ids, id])],
            }),
          },
          tag.name,
        ),
      );
      const box = cards.get(comic.id).tagBox;
      box.replaceChildren(...chips.slice(0, 8));
      if (chips.length > 8)
        box.append(
          el("details", { class: "comic-more-tags" }, [
            el("summary", {}, `另 ${chips.length - 8} 个标签`),
            el("div", {}, chips.slice(8)),
          ]),
        );
      if (values.some((value) => value?.error))
        box.append(
          button(
            "部分标签未能读取 · 重试",
            () => void loadTags([comic], cards, requestSignal),
            "btn btn-sm btn-quiet",
          ),
        );
      if (values.some((value) => value?.missing))
        box.append(
          el(
            "a",
            { href: "#/pending", class: "comic-tag-note" },
            "有来源标签待整理 · 查看队列",
          ),
        );
      if (!values.length) box.append(el("small", {}, "暂无标签"));
    }
  }

  async function show(hash, requestSignal) {
    coverController?.abort();
    signal = requestSignal;
    searchController?.abort();
    clearTimeout(searchTimer);
    closeSuggestions();
    records.clear();
    cards = new Map();
    $("browse-tag-input").value = "";
    $("browse-tag-input").setCustomValidity("");
    $("browse-pagination-top").replaceChildren();
    $("browse-pagination-bottom").replaceChildren();
    $("browse-active-filters").replaceChildren();
    $("browse-results").setAttribute("aria-busy", "true");
    $("browse-results").replaceChildren(empty("正在读取漫画库…"));
    try {
      filters = parseLibraryHash(hash);
      selected = [...filters.generic_tag_ids];
      $("browse-title").value = filters.title;
      $("browse-author").value = filters.author_name;
      $("browse-title-match").value = filters.title_match;
      $("browse-author-match").value = filters.author_match;
      $("browse-tag-match").value = filters.tag_match;
      for (const id of ["browse-title", "browse-author"])
        $(id).setCustomValidity("");
      renderSelected();
      const descriptions = [
        filters.title &&
          `标题${matchNames[filters.title_match]}「${filters.title}」`,
        filters.author_name &&
          `作者${matchNames[filters.author_match]}「${filters.author_name}」`,
        selected.length &&
          `${selected.length} 个标签 · ${filters.tag_match === "all" ? "全部满足" : "任一满足"}`,
      ].filter(Boolean);
      $("browse-active-filters").textContent = descriptions.length
        ? `当前结果：${descriptions.join(" · ")}`
        : "";
      const names = mapLimit(selected, 6, async (id) => {
        try {
          const { data } = await api(`/tags/generic/${id}`, {
            signal: requestSignal,
          });
          if (!requestSignal.aborted) tagNames.set(id, data);
        } catch {
          /* 保留可移除的 ID 标签块，漫画查询仍按该 ID 筛选。 */
        }
      }).then(() => {
        if (!requestSignal.aborted) renderSelected();
      });
      const { comics, total } = await queryComics(filters, requestSignal);
      if (requestSignal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(total / filters.limit));
      if (filters.page > lastPage) {
        const corrected = libraryHash({ ...filters, page: lastPage });
        history.replaceState(null, "", corrected);
        void refreshRoute();
        return;
      }
      cards = new Map(comics.map((comic) => [comic.id, card(comic)]));
      for (const comic of comics) records.set(comic.id, comic);
      $("browse-results").replaceChildren(
        ...(comics.length
          ? [...cards.values()].map((item) => item.node)
          : [
              el("div", { class: "browse-empty" }, [
                empty(
                  descriptions.length ? "没有匹配的漫画" : "漫画库还是空的",
                  descriptions.length
                    ? "调整标题、作者或标签后重新检索。"
                    : "已录入的漫画会显示在这里。",
                ),
                descriptions.length
                  ? button(
                      "清除筛选",
                      () => navigate(parseLibraryHash()),
                      "btn btn-outline-secondary",
                    )
                  : el(
                      "a",
                      { href: "#/entry", class: "btn btn-outline-primary" },
                      "录入漫画",
                    ),
              ]),
            ]),
      );
      $("browse-pagination-top").replaceChildren(...pagination(total, "顶部"));
      $("browse-pagination-bottom").replaceChildren(
        ...pagination(total, "底部"),
      );
      $("browse-results").setAttribute("aria-busy", "false");
      announce(`找到 ${total} 部漫画，当前第 ${filters.page} 页。`);
      await Promise.allSettled([
        names,
        loadTags(comics, cards, requestSignal),
        refreshImages(),
      ]);
    } catch (error) {
      if (requestSignal.aborted) return;
      $("browse-results").replaceChildren(errorBox(error, refreshRoute));
      $("browse-results").setAttribute("aria-busy", "false");
    }
  }
  return {
    show,
    refreshImages,
    getComic: (id) => records.get(id),
    clear: () => records.clear(),
  };
}

import {
  ApiError,
  query,
  api,
  request,
  exactMapping,
  exactGeneric,
  stableKey,
  mapLimit,
} from "./entry-api.js";

const matches = ["exact", "prefix", "contains"];
export const PAGE_SIZES = [20, 50, 100];

export function parseLibraryHash(hash = "#/") {
  const queryStart = hash.indexOf("?");
  const params = new URLSearchParams(
    queryStart < 0 ? "" : hash.slice(queryStart + 1),
  );
  const positive = (value) =>
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0;
  const ids = params.get("tags")?.split(",").filter(Boolean) || [];
  if (ids.some((id) => !positive(id)) || ids.length > 100)
    throw new Error("标签筛选链接无效，请清除筛选后重试。");
  const page = params.get("page") || "1";
  const size = Number(params.get("size") || 20);
  if (
    !positive(page) ||
    !PAGE_SIZES.includes(size) ||
    !Number.isSafeInteger((Number(page) - 1) * size)
  )
    throw new Error("页码或每页数量无效，请清除筛选后重试。");
  const titleMatch = params.get("title_match") || "contains";
  const authorMatch = params.get("author_match") || "exact";
  const tagMatch = params.get("tag_match") || "all";
  if (
    !matches.includes(titleMatch) ||
    !matches.includes(authorMatch) ||
    !["all", "any"].includes(tagMatch)
  )
    throw new Error("匹配方式无效，请清除筛选后重试。");
  return {
    title: params.get("title") || "",
    title_match: titleMatch,
    author_name: params.get("author") || "",
    author_match: authorMatch,
    generic_tag_ids: [...new Set(ids.map(Number))],
    tag_match: tagMatch,
    page: Number(page),
    limit: size,
  };
}

export function libraryHash(filters) {
  const params = new URLSearchParams();
  if (filters.title) params.set("title", filters.title);
  if (filters.author_name) params.set("author", filters.author_name);
  if (filters.title_match !== "contains")
    params.set("title_match", filters.title_match);
  if (filters.author_match !== "exact")
    params.set("author_match", filters.author_match);
  if (filters.generic_tag_ids.length)
    params.set("tags", [...new Set(filters.generic_tag_ids)].join(","));
  if (filters.tag_match !== "all") params.set("tag_match", filters.tag_match);
  if (filters.page > 1) params.set("page", String(filters.page));
  if (filters.limit !== 20) params.set("size", String(filters.limit));
  return "#/" + (params.size ? "?" + params : "");
}

export function libraryReturn(value) {
  if (!value || !/^#\/(?:\?.*)?$/.test(value)) return "#/";
  try {
    return libraryHash(parseLibraryHash(value));
  } catch {
    return "#/";
  }
}

export async function queryComics(filters, signal) {
  const { page, title, author_name, ...rest } = filters;
  const { data, headers } = await query(
    "/comics/query",
    {
      ...rest,
      order: "DESC",
      title: title || null,
      author_name: author_name || null,
      offset: (page - 1) * rest.limit,
    },
    signal,
  );
  const count = headers.get("X-Total-Count");
  const total = Number(count);
  if (
    !Array.isArray(data) ||
    !/^\d+$/.test(count || "") ||
    !Number.isSafeInteger(total) ||
    data.length > rest.limit ||
    data.some(
      (comic) =>
        !Number.isSafeInteger(comic.id) || !Array.isArray(comic.comic_tags),
    )
  )
    throw new ApiError(
      "漫画列表缺少有效数据或总数，请重试。",
      "INVALID_RESPONSE",
    );
  return { comics: data, total };
}

// 仅在当前页面请求内去重；刷新时重新读取关系，避免保留已变化的标签映射。
export async function resolveLibraryTags(comics, signal, onResolved) {
  const specifics = new Map(
    comics
      .flatMap((comic) => comic.comic_tags)
      .map((tag) => [stableKey(tag), tag]),
  );
  const genericIds = new Map();
  async function resolve(tag) {
    signal?.throwIfAborted();
    try {
      const mapping = await exactMapping(tag, signal);
      if (!mapping) return { missing: true, specific: tag };
      const genericKey = JSON.stringify([
        mapping.generic.tag_group,
        mapping.generic.name,
      ]);
      if (!genericIds.has(genericKey))
        genericIds.set(genericKey, exactGeneric(mapping.generic, signal));
      const id = await genericIds.get(genericKey);
      if (id === null)
        throw new ApiError(
          "通用标签已变化，请重试读取。",
          "MISSING_GENERIC_TAG",
        );
      return { id, tag: mapping.generic };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { error, specific: tag };
    }
  }
  const entries = await mapLimit([...specifics], 6, async ([key, tag]) => {
    const result = await resolve(tag);
    signal?.throwIfAborted();
    // 每条结果立即通知页面；最终 Map 仍可供详情页等调用者一次性读取。
    onResolved?.(key, result);
    return [key, result];
  });
  return new Map(entries);
}

export async function searchLibraryTags(groups, name, signal) {
  if (!name.trim()) return { tags: [], total: 0 };
  const results = await mapLimit(groups, 3, async (group) => {
    signal?.throwIfAborted();
    const { data, headers } = await query(
      "/tags/generic/query",
      {
        tag_group: group,
        name,
        name_match: "contains",
        limit: 12,
        offset: 0,
      },
      signal,
    );
    const count = headers.get("X-Total-Count");
    const total = Number(count);
    if (
      !Array.isArray(data) ||
      !/^\d+$/.test(count || "") ||
      !Number.isSafeInteger(total)
    )
      throw new ApiError("标签查询缺少有效总数，请重试。", "INVALID_RESPONSE");
    return { ids: data, total };
  });
  return {
    tags: await mapLimit(
      results.flatMap((result) => result.ids),
      6,
      async (id) => {
        signal?.throwIfAborted();
        return { id, tag: (await api(`/tags/generic/${id}`, { signal })).data };
      },
    ),
    total: results.reduce((sum, result) => sum + result.total, 0),
  };
}

export function documentPages(document) {
  if (["deleted", "purged"].includes(document.status)) return [];
  return [
    ...new Map(
      (document.pages || [])
        .filter((page) => Number.isSafeInteger(page.index) && page.index >= 0)
        .map((page) => [page.index, page]),
    ).values(),
  ].sort((a, b) => a.index - b.index);
}

export function storageImageUrl(value, route = "proxy") {
  const original = typeof value === "string" ? value.trim() : "";
  let url;
  try {
    url = new URL(original);
  } catch {
    throw new ApiError("未取得有效的图片地址，请重试。", "INVALID_IMAGE_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["proxy", "direct"].includes(route)
  )
    throw new ApiError(
      "图片地址或线路无效，请检查连接设置。",
      "INVALID_IMAGE_URL",
    );
  if (route === "direct" && url.origin === "https://dmb-oss.hayaseyuuka.date") {
    // 仅替换已知存储入口，原始路径与签名查询字符串逐字保留。
    return original.replace(
      /^https:\/\/[^/?#]+/i,
      "https://dmb-oss.khadas.hayaseyuuka.date:8880",
    );
  }
  return original;
}

export async function pageImageUrl(base, id, index, route = "proxy", signal) {
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw new Error("无效的漫画页地址。");
  const { data } = await request(
    `${base}/v1/documents/${id}/pages/${index}?url=1&token=viewer`,
    { external: true, responseType: "text", redirect: "error", signal },
  );
  signal?.throwIfAborted();
  return storageImageUrl(data, route);
}

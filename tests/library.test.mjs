import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLibraryHash,
  libraryHash,
  libraryReturn,
  queryComics,
  resolveLibraryTags,
  searchLibraryTags,
  documentPages,
  pageImageUrl,
  storageImageUrl,
} from "../src/comic-library.js";
import { stableKey } from "../src/entry-api.js";

const response = (data, total, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(total === undefined ? {} : { "X-Total-Count": String(total) }),
    },
  });

test("检索条件与页码在链接中完整往返，保留文字中的空格和特殊字符", () => {
  const filters = {
    ...parseLibraryHash(),
    title: " 中文 & 100%_ ? #/ ",
    author_name: "A+B / C",
    title_match: "exact",
    author_match: "prefix",
    generic_tag_ids: [7, 21],
    tag_match: "any",
    page: 3,
    limit: 50,
  };
  assert.deepEqual(parseLibraryHash(libraryHash(filters)), filters);
  assert.equal(libraryHash(parseLibraryHash()), "#/");
  assert.equal(parseLibraryHash("#/?title=a?b").title, "a?b");
  assert.deepEqual(parseLibraryHash("#/?tags=7,7,21").generic_tag_ids, [7, 21]);
});

test("非法页码、标签和匹配方式不能静默变为无条件查询", () => {
  for (const hash of [
    "#/?page=-1",
    "#/?page=0",
    "#/?page=1.5",
    "#/?size=999",
    "#/?tags=0",
    "#/?tags=abc",
    "#/?tags=9007199254740992",
    "#/?page=9007199254740991",
    "#/?tag_match=none",
    "#/?title_match=regex",
    "#/?author_match=fuzzy",
  ])
    assert.throws(() => parseLibraryHash(hash), hash);
});

test("详情返回地址只接受漫画库查询路由", () => {
  for (const value of [
    null,
    "https://example.com/",
    "javascript:alert(1)",
    "#/entry/1",
    "#/read/1",
    "#/comic/1",
    "#/?tags=bad",
  ])
    assert.equal(libraryReturn(value), "#/");
  assert.equal(
    libraryReturn("#/?author=Alice&page=2"),
    "#/?author=Alice&page=2",
  );
});

test("漫画查询用 POST 提交组合条件，分页换算与后端约定一致", async (t) => {
  const comic = {
    id: 19,
    title: "本地标题",
    authors: ["Alice"],
    comic_tags: [],
    updated_at: "2026-09-06T00:00:00Z",
  };
  let received;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    received = {
      url,
      method: options.method,
      body: JSON.parse(options.body),
      credentials: options.credentials,
    };
    return response([comic], 63);
  });
  const result = await queryComics({
    ...parseLibraryHash(),
    title: "中文%_",
    author_name: "Alice",
    generic_tag_ids: [7, 21],
    page: 2,
  });
  assert.deepEqual(received, {
    url: "/api/comics/query",
    method: "POST",
    credentials: "same-origin",
    body: {
      title: "中文%_",
      title_match: "contains",
      author_name: "Alice",
      author_match: "exact",
      generic_tag_ids: [7, 21],
      tag_match: "all",
      order: "DESC",
      limit: 20,
      offset: 20,
    },
  });
  assert.deepEqual(result, { comics: [comic], total: 63 });
});

test("无筛选时省略文字条件，空页仍保留总数", async (t) => {
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.title, null);
    assert.equal(body.author_name, null);
    assert.equal(body.order, "DESC");
    return response([], 12);
  });
  assert.deepEqual(await queryComics({ ...parseLibraryHash(), page: 5 }), {
    comics: [],
    total: 12,
  });
});

test("无效列表响应不能被当作空库", async (t) => {
  const bodies = [
    response([]),
    response([], -1),
    response([], "abc"),
    response({}, 1),
    response([{ id: "1", comic_tags: [] }], 1),
  ];
  t.mock.method(globalThis, "fetch", async () => bodies.shift());
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      queryComics(parseLibraryHash()),
      (error) => error.code === "INVALID_RESPONSE",
    );
});

test("标签提示跨分类执行包含搜索，并区分不同分类的同名标签", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({
      url,
      method: options.method,
      body: options.body && JSON.parse(options.body),
    });
    if (url === "/api/tags/generic/query") {
      const body = JSON.parse(options.body);
      assert.equal(body.name, "eye%_");
      assert.equal(body.name_match, "contains");
      return response([body.tag_group === "tag" ? 17 : 29], 1);
    }
    return response({
      name: "eye%_glasses",
      tag_group: url.endsWith("17") ? "tag" : "character",
    });
  });
  const result = await searchLibraryTags(["tag", "character"], "eye%_");
  assert.deepEqual(result, {
    tags: [
      { id: 17, tag: { name: "eye%_glasses", tag_group: "tag" } },
      { id: 29, tag: { name: "eye%_glasses", tag_group: "character" } },
    ],
    total: 2,
  });
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every((call) => call.url.includes("/query") || call.method === "GET"),
  );
});

test("清空标签输入不请求全库，取消提示搜索不继续发送请求", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response([], 0);
  });
  assert.deepEqual(await searchLibraryTags(["tag"], "  "), {
    tags: [],
    total: 0,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchLibraryTags(["tag"], "glasses", controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(calls, 0);
});

test("标签展示去重查询相同来源身份，并通过独立接口获取通用标签及 ID", async (t) => {
  const female = {
    site: "hitomi",
    origin_name: "glasses",
    group: "tags",
    tag_sex: "female",
  };
  const male = { ...female, tag_sex: "male" };
  const generic = { tag_group: "tag", name: "眼镜" };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    if (url === "/api/tags/specific/query")
      return response([
        JSON.parse(options.body).specific_tag.tag_sex === "female" ? 1 : 2,
      ]);
    if (url.endsWith("/generic")) return response(generic);
    if (url === "/api/tags/generic/query") return response([25], 1);
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await resolveLibraryTags([
    { comic_tags: [female, male] },
    { comic_tags: [female] },
  ]);
  assert.deepEqual(result.get(stableKey(female)), { id: 25, tag: generic });
  assert.deepEqual(result.get(stableKey(male)), { id: 25, tag: generic });
  assert.equal(
    calls.filter((url) => url === "/api/tags/specific/query").length,
    2,
  );
  assert.equal(
    calls.filter((url) => url === "/api/tags/generic/query").length,
    1,
  );
});

test("失效或失败的来源映射保留状态，不捏造通用标签", async (t) => {
  const tag = { site: "hitomi", origin_name: "missing", group: "tags" };
  t.mock.method(globalThis, "fetch", async () => response([]));
  const result = await resolveLibraryTags([{ comic_tags: [tag] }]);
  assert.deepEqual(result.get(stableKey(tag)), {
    missing: true,
    specific: tag,
  });
});

test("阅读按实际页面 index 排序去重，不假设从零连续；删除来源不可读", () => {
  const pages = [
    { index: 7 },
    { index: 2 },
    { index: 7 },
    { index: -1 },
    { index: "4" },
  ];
  assert.deepEqual(documentPages({ pages, status: "archived" }), [
    { index: 2 },
    { index: 7 },
  ]);
  assert.deepEqual(documentPages({ pages, status: "deleted" }), []);
  assert.deepEqual(documentPages({ pages, status: "purged" }), []);
});

const signedImage =
  "https://dmb-oss.hayaseyuuka.date/documents/documents/25/a%2Fb%20c.webp" +
  "?X-Amz-Credential=viewer%2Fscope&X-Amz-Signature=abc123&encoded=%2f%2B+%20&repeat=2&repeat=1";

test("图片线路切换只替换已知存储入口，路径和签名参数逐字保留", () => {
  assert.equal(storageImageUrl(signedImage, "proxy"), signedImage);
  assert.equal(
    storageImageUrl(signedImage, "direct"),
    signedImage.replace(
      "https://dmb-oss.hayaseyuuka.date",
      "https://dmb-oss.khadas.hayaseyuuka.date:8880",
    ),
  );
  const direct = storageImageUrl(signedImage, "direct");
  assert.equal(storageImageUrl(direct, "direct"), direct);
  for (const host of [
    "storage.example",
    "dmb-oss.hayaseyuuka.date.example.com",
    "dmb-oss.hayaseyuuka.date:9000",
  ]) {
    const custom = signedImage.replace("dmb-oss.hayaseyuuka.date", host);
    assert.equal(storageImageUrl(custom, "direct"), custom);
  }
});

test("图片 URL 接口按纯文本读取，无 Content-Type 也能工作，禁止跟随旧接口重定向", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    received = { url, ...options };
    const result = new Response(signedImage);
    result.headers.delete("Content-Type");
    return result;
  });
  assert.equal(
    await pageImageUrl("https://dmb.example", 25, 7, "direct"),
    storageImageUrl(signedImage, "direct"),
  );
  assert.equal(
    received.url,
    "https://dmb.example/v1/documents/25/pages/7?url=1&token=viewer",
  );
  assert.equal(received.credentials, "omit");
  assert.equal(received.redirect, "error");
  assert.equal(received.cache, "no-store");
});

test("图片 URL 接口的鉴权错误保留状态码，失败内容不能被当作 URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    response({ error: "无权读取" }, undefined, 401),
  );
  await assert.rejects(
    pageImageUrl("https://dmb.example", 25, 7),
    (error) => error.status === 401 && error.message === "无权读取",
  );
});

test("无效图片地址和页面索引不会成为图片请求", async (t) => {
  for (const url of [
    "",
    "<html>error</html>",
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "https://user:password@storage.example/a",
  ]) {
    assert.throws(() => storageImageUrl(url, "direct"), /图片地址/);
  }
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("不应发起网络请求");
  });
  for (const [id, index] of [
    [25, -1],
    [0, 0],
    [25, 1.5],
    [25, "7"],
  ])
    await assert.rejects(
      pageImageUrl("https://dmb.example", id, index),
      /无效的漫画页地址/,
    );
});

test("线路切换或离开页面后，已取消的签发响应不能继续加载图片", async (t) => {
  const controller = new AbortController();
  let resolveBody;
  let readingBody;
  const started = new Promise((resolve) => {
    readingBody = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () =>
      new Promise((resolve) => {
        resolveBody = resolve;
        readingBody();
      }),
  }));
  const pending = pageImageUrl(
    "https://dmb.example",
    25,
    7,
    "direct",
    controller.signal,
  );
  await started;
  controller.abort();
  resolveBody(signedImage);
  await assert.rejects(pending, { name: "AbortError" });
});

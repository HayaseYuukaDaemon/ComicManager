import test from "node:test";
import assert from "node:assert/strict";
import {
  getHitomiId,
  parseGalleryInfo,
  hitomiImageUrl,
  loadHitomiDocument,
} from "../src/hitomi-viewer.js";
import { loadDmbDocument } from "../src/dmb-viewer.js";
import { createReaderImageCache } from "../src/viewer-image-cache.js";

const pageLocation = new URL("https://viewer.example/hitomi-viewer.html?id=42");
const routing = { b: "12345/", m: () => 1, s: () => "789" };
const files = ["f", "a", "0"].map((value) => ({
  hash: value.repeat(61) + "123",
  name: `${value}.png`,
}));
const galleryText = (data = {}) =>
  `var galleryinfo = ${JSON.stringify({ id: "42", title: "示例画廊", files, ...data })};`;

test("Hitomi 支持两种 query 参数和原有路径 ID，不把非法 ID 当成有效画廊", () => {
  for (const path of [
    "/hitomi-viewer.html?id=42&other=1",
    "/hitomi-viewer.html?hitomi_id=42",
    "/hitomi-viewer.html?hitomi_id=42&id=99",
    "/reader/42.html",
    "/reader/title-42.html",
    "/reader/42/",
  ]) assert.equal(getHitomiId(new URL(path, pageLocation)), 42);
  for (const value of ["", "0", "-1", "1.5", "1e2", "bad", "9007199254740993"])
    assert.throws(
      () => getHitomiId(new URL(`/hitomi-viewer.html?id=${value}`, pageLocation)),
      /有效的 Hitomi ID/,
    );
});

test("画廊脚本仅解析 JSON 赋值，拒绝 HTML 和额外 JavaScript", () => {
  assert.equal(parseGalleryInfo(galleryText()).id, "42");
  assert.equal(parseGalleryInfo('galleryinfo = {"id": 42}\n').id, 42);
  for (const text of [
    "<html>galleryinfo</html>",
    'other = {"id": 42};',
    'galleryinfo = {id: 42};',
    'galleryinfo = {"id": 42}; alert("unexpected");',
    'galleryinfo = {"id": (() => 42)()};',
  ]) assert.throws(() => parseGalleryInfo(text), /解析失败/);
});

test("Hitomi WebP 地址保留 gg 分片和路径规则，并通过原 Worker 附带来源 referer", () => {
  let requestedShard;
  const proxy = new URL(hitomiImageUrl(files[0], {
    ...routing,
    m: (shard) => { requestedShard = shard; return 1; },
  }));
  assert.equal(requestedShard, 0x312);
  assert.equal(proxy.origin, "https://document-worker.hayaseyuuka.date");
  assert.equal(proxy.searchParams.get("refererURL"), "https://hitomi.la");
  assert.equal(
    proxy.searchParams.get("urlToProxy"),
    `https://w2.gold-usergeneratedcontent.net/12345/789/${files[0].hash}.webp`,
  );
  assert.throws(() => hitomiImageUrl({ hash: "../bad" }, routing), /信息不完整/);
});

test("Hitomi 实际接入共用队列后按 files 顺序缓存整部，回翻复用 Blob，不请求 CM", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.hostname.startsWith("ltn.")) return new Response(galleryText());
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/webp" },
    });
  });
  const source = await loadHitomiDocument(new AbortController().signal, {
    pageLocation, routing,
  });
  assert.deepEqual(source.pages, [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.equal(source.title, "示例画廊 - Hitomi Viewer");
  assert.equal(requests.length, 1);
  let done;
  const complete = new Promise((resolve) => { done = resolve; });
  const cache = createReaderImageCache({
    keys: source.pages.map((page) => page.index),
    load: source.loadPage,
    onChange: (progress) => { if (progress.ready === 3) done(); },
  });
  t.after(() => cache.clear());
  const first = await cache.show(0);
  await complete;
  assert.match(first.url, /^blob:/);
  assert.equal(await cache.show(0), first);
  assert.equal(requests.length, 4);
  assert.equal(cache.stats().bytes, 9);
  assert.deepEqual(
    requests.slice(1).map(({ url }) => url.searchParams.get("urlToProxy")),
    files.map((file) => `https://w2.gold-usergeneratedcontent.net/12345/789/${file.hash}.webp`),
  );
  for (const { url, options } of requests) {
    assert.ok(["ltn.gold-usergeneratedcontent.net", "document-worker.hayaseyuuka.date"].includes(url.hostname));
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("Hitomi 缺失路由、错误画廊、空画廊和不完整图片都停止初始化", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(galleryText()));
  const controller = new AbortController();
  await assert.rejects(loadHitomiDocument(controller.signal, { pageLocation, routing: {} }), /gg.js/);
  assert.equal(fetchMock.mock.callCount(), 0);
  for (const [data, error] of [
    [{ id: "43" }, /其他画廊/],
    [{ files: [] }, /任何图片/],
    [{ files: [null] }, /信息不完整/],
  ]) {
    fetchMock.mock.mockImplementation(async () => new Response(galleryText(data)));
    await assert.rejects(loadHitomiDocument(controller.signal, { pageLocation, routing }), error);
  }
});

test("Hitomi 文档请求报告 HTTP 错误，并丢弃退出后才返回的结果", async (t) => {
  const controller = new AbortController();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  await assert.rejects(loadHitomiDocument(controller.signal, { pageLocation, routing }), /HTTP 503/);
  fetchMock.mock.mockImplementation(async () => {
    controller.abort();
    return new Response(galleryText());
  });
  await assert.rejects(loadHitomiDocument(controller.signal, { pageLocation, routing }), { name: "AbortError" });
});

test("DMB 抽出来源模块后保留实际页索引排序去重和纯文本签发流程", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.hostname === "images.example")
      return new Response(new Uint8Array([1, 2]));
    if (url.pathname.endsWith("/pages/7"))
      return new Response("https://images.example/page-7");
    return Response.json({
      document_id: 42, title: "DMB 示例", status: "archived",
      pages: [{ index: 7 }, { index: -1 }, { index: 2 }, { index: 7 }, { index: "3" }],
    });
  });
  const source = await loadDmbDocument(new AbortController().signal, pageLocation);
  assert.deepEqual(source.pages, [{ index: 2 }, { index: 7 }]);
  assert.equal(source.title, "DMB 示例 · 阅览");
  const page = await source.loadPage(7, new AbortController().signal);
  t.after(() => URL.revokeObjectURL(page.url));
  assert.equal(requests[1].url.pathname, "/v1/documents/42/pages/7");
  assert.equal(requests[1].url.searchParams.get("url"), "1");
  assert.equal(requests[1].url.searchParams.get("token"), "viewer");
  assert.equal(requests[1].options.redirect, "error");
  assert.equal(requests[2].url.href, "https://images.example/page-7");
  assert.equal(page.bytes, 2);
});

test("DMB 保留非法 ID、已删除、空文档和错误文档的校验", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const signal = new AbortController().signal;
  await assert.rejects(loadDmbDocument(signal, new URL("https://viewer.example/?id=bad")), /有效的文档 ID/);
  assert.equal(fetchMock.mock.callCount(), 0);
  for (const [data, error] of [
    [{ document_id: 99 }, /其他文档/],
    [{ document_id: 42, status: "deleted" }, /已删除/],
    [{ document_id: 42, status: "purged" }, /已删除/],
    [{ document_id: 42, pages: [] }, /内容为空/],
  ]) {
    fetchMock.mock.mockImplementation(async () => Response.json(data));
    await assert.rejects(loadDmbDocument(signal, pageLocation), error);
  }
});

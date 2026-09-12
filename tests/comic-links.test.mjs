import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIEWER_URL,
  validateViewerUrl,
  viewerLink,
  comicDetailLink,
} from "../src/comic-links.js";

const base = "https://comic.example/exploror#/comic/2658";

test("默认阅览器使用本站独立页面，空白配置恢复默认", () => {
  assert.equal(DEFAULT_VIEWER_URL, "/dmb-viewer.html");
  assert.equal(validateViewerUrl("  ", base), DEFAULT_VIEWER_URL);
  assert.equal(
    viewerLink(DEFAULT_VIEWER_URL, 2658, base),
    "https://comic.example/dmb-viewer.html?id=2658",
  );
});

test("外部阅览器 URL 保留参数和片段，将 DMB ID 写入真实 query", () => {
  const link = new URL(
    viewerLink(
      "https://viewer.example/read?theme=dark&language=zh#reader",
      2658,
      base,
    ),
  );
  assert.equal(link.origin + link.pathname, "https://viewer.example/read");
  assert.equal(link.searchParams.get("id"), "2658");
  assert.equal(link.searchParams.get("theme"), "dark");
  assert.equal(link.searchParams.get("language"), "zh");
  assert.equal(link.hash, "#reader");
});

test("已有 id 被替换且去重，其他重复参数保留", () => {
  const link = new URL(
    viewerLink("https://viewer.example/?id=old&tag=a&tag=b&id=stale", 42, base),
  );
  assert.deepEqual(link.searchParams.getAll("id"), ["42"]);
  assert.deepEqual(link.searchParams.getAll("tag"), ["a", "b"]);
});

test("本站路径保持相对存储，切换部署域名后仍指向本站", () => {
  const saved = validateViewerUrl(" /dmb-viewer.html?theme=dark ", base);
  assert.equal(saved, "/dmb-viewer.html?theme=dark");
  assert.equal(
    viewerLink(saved, 9, "http://localhost:8000/exploror"),
    "http://localhost:8000/dmb-viewer.html?theme=dark&id=9",
  );
});

test("阅览器只允许 HTTP / HTTPS，不允许可执行协议或嵌入账号", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/a.html",
    "https://user:pass@viewer.example",
    "not a URL",
  ])
    assert.throws(() => validateViewerUrl(value, base), value);
  for (const id of [0, -1, 1.5, NaN, "42", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => viewerLink(DEFAULT_VIEWER_URL, id, base));
});

test("漫画链接进入详情，并完整保留返回检索条件与页码", () => {
  const back = "#/?title=中文%26标题&author=Alice&page=3&tags=7,21";
  const hash = comicDetailLink(2658, back);
  assert.ok(hash.startsWith("#/comic/2658?"));
  assert.equal(
    new URLSearchParams(hash.split("?")[1]).get("back"),
    "#/?title=%E4%B8%AD%E6%96%87%26%E6%A0%87%E9%A2%98&author=Alice&tags=7%2C21&page=3",
  );
  assert.equal(
    new URLSearchParams(
      comicDetailLink(42, "https://evil.example").split("?")[1],
    ).get("back"),
    "#/",
  );
});

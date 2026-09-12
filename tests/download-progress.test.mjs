import test from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_STATUSES,
  downloadProgress,
  readDownloadDocuments,
  pollDownloads,
} from "../src/download-progress.js";

const doc = (id, status = "downloading", extra = {}) => ({
  document_id: id,
  title: `漫画 ${id}`,
  status,
  updated_at: "2026-09-12T08:00:00Z",
  progress: { done: 9, total: 26 },
  ...extra,
});
const response = (data) => new Response(JSON.stringify(data));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("仅按非 archived 状态查询，包含失败、删除和清理记录，不读取 CM 或已归档库", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://dmb.test/v1/documents/query");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer viewer");
    const body = JSON.parse(options.body);
    assert.equal(body.mode, "by_status");
    assert.equal(body.limit, 100);
    assert.equal(body.offset, 0);
    assert.notEqual(body.params.status, "archived");
    requests.push(body.params.status);
    return response([
      doc(
        DOWNLOAD_STATUSES.indexOf(body.params.status) + 1,
        body.params.status,
      ),
    ]);
  });
  const rows = await readDownloadDocuments("https://dmb.test");
  assert.deepEqual(requests, DOWNLOAD_STATUSES);
  assert.deepEqual(
    rows.map((row) => row.status),
    DOWNLOAD_STATUSES,
  );
});

test("同一状态超过 100 部会继续分页，ID 倒序且没有截断", async (t) => {
  const offsets = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body);
    if (body.params.status !== "failed") return response([]);
    offsets.push(body.offset);
    return response(
      Array.from({ length: Math.min(100, 205 - body.offset) }, (_, i) =>
        doc(205 - body.offset - i, "failed"),
      ),
    );
  });
  const rows = await readDownloadDocuments("https://dmb.test");
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(rows.length, 205);
  assert.equal(rows[0].document_id, 205);
  assert.equal(rows.at(-1).document_id, 1);
});

test("轮询期间状态切换按较新记录去重，已归档记录移除", async (t) => {
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const { params } = JSON.parse(options.body);
    if (params.status === "downloading") return response([doc(1), doc(2)]);
    if (params.status === "failed")
      return response([
        doc(1, "failed", { updated_at: "2026-09-12T08:00:00.000000001Z" }),
        doc(2, "archived", { updated_at: "2026-09-12T08:00:01Z" }),
      ]);
    return response([]);
  });
  const rows = await readDownloadDocuments("https://dmb.test");
  assert.deepEqual(
    rows.map((row) => [row.document_id, row.status]),
    [[1, "failed"]],
  );
});

test("异常响应和停滞分页必须报错，不能显示为没有下载", async (t) => {
  let data = { error: "bad response" };
  t.mock.method(globalThis, "fetch", async () => response(data));
  await assert.rejects(readDownloadDocuments("https://dmb.test"), {
    code: "INVALID_RESPONSE",
  });
  data = Array.from({ length: 100 }, (_, i) => doc(i));
  await assert.rejects(
    readDownloadDocuments("https://dmb.test"),
    /分页未向后推进/,
  );
});

test("退出会取消所有状态请求，失败时也取消尚未完成的其他请求", async (t) => {
  const jobs = [];
  t.mock.method(
    globalThis,
    "fetch",
    (_, options) =>
      new Promise((resolve, reject) => {
        jobs.push({ resolve, reject, signal: options.signal });
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const pending = readDownloadDocuments("https://dmb.test", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(jobs.every((job) => job.signal.aborted));
  jobs.length = 0;
  const failed = readDownloadDocuments("https://dmb.test");
  jobs[0].reject(new Error("offline"));
  await assert.rejects(failed, /连接失败/);
  assert.ok(jobs.every((job) => job.signal.aborted));
});

test("未知总页数不伪造百分比，失败保留实际已完成页数", () => {
  assert.deepEqual(downloadProgress(doc(1, "failed")), {
    done: 9,
    total: 26,
    percent: 34.6,
  });
  assert.deepEqual(
    downloadProgress(doc(1, "queued", { progress: { done: 0, total: 0 } })),
    { done: 0, total: null, percent: null },
  );
  assert.deepEqual(downloadProgress({}), {
    done: null,
    total: null,
    percent: null,
  });
  assert.deepEqual(downloadProgress({ progress: { done: -1, total: "10" } }), {
    done: null,
    total: null,
    percent: null,
  });
  assert.deepEqual(downloadProgress({ progress: { done: 0, total: 10 } }), {
    done: 0,
    total: 10,
    percent: 0,
  });
  assert.deepEqual(downloadProgress({ progress: { done: 12, total: 10 } }), {
    done: 12,
    total: 10,
    percent: 100,
  });
});

function pollSetup(t) {
  let interval;
  const cleared = [];
  t.mock.method(globalThis, "setInterval", (callback, ms) => {
    assert.equal(ms, 1000);
    interval = callback;
    return 42;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => cleared.push(timer));
  const jobs = [],
    updates = [],
    errors = [];
  const controller = new AbortController();
  const stop = pollDownloads("https://dmb.test", {
    signal: controller.signal,
    read: (_, { signal }) =>
      new Promise((resolve, reject) => jobs.push({ resolve, reject, signal })),
    onData: (rows) => updates.push(rows),
    onError: (error) => errors.push(error),
  });
  t.after(stop);
  return {
    jobs,
    updates,
    errors,
    controller,
    cleared,
    stop,
    fire: () => interval(),
  };
}

test("进入立即刷新，之后每秒一轮，慢请求不叠加，完成记录随下一轮移除", async (t) => {
  const p = pollSetup(t);
  assert.equal(p.jobs.length, 1);
  await p.fire();
  await p.fire();
  assert.equal(p.jobs.length, 1);
  p.jobs[0].resolve([doc(1)]);
  await tick();
  const next = p.fire();
  assert.equal(p.jobs.length, 2);
  p.jobs[1].resolve([]);
  await next;
  assert.deepEqual(p.updates, [[doc(1)], []]);
});

test("请求失败不覆盖上次结果，下一秒可自动恢复", async (t) => {
  const p = pollSetup(t);
  p.jobs[0].resolve([doc(1)]);
  await tick();
  const failed = p.fire();
  p.jobs[1].reject(new Error("offline"));
  await failed;
  assert.equal(p.updates.length, 1);
  assert.equal(p.errors.length, 1);
  const retry = p.fire();
  p.jobs[2].resolve([doc(1, "failed")]);
  await retry;
  assert.equal(p.updates[1][0].status, "failed");
});

test("路由退出取消计时器与在途请求，旧响应不能更新界面", async (t) => {
  const p = pollSetup(t);
  p.controller.abort();
  assert.deepEqual(p.cleared, [42]);
  assert.equal(p.jobs[0].signal.aborted, true);
  p.jobs[0].resolve([doc(1)]);
  await tick();
  await p.fire();
  assert.equal(p.jobs.length, 1);
  assert.deepEqual(p.updates, []);
  assert.deepEqual(p.errors, []);
});

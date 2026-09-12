import test from "node:test";
import assert from "node:assert/strict";
import {
  createReaderImageCache,
  loadReaderPage,
} from "../src/viewer-image-cache.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, keys, options = {}) {
  const jobs = [];
  const released = [];
  const updates = [];
  let active = 0;
  let maximum = 0;
  const cache = createReaderImageCache({
    keys,
    timeoutMs: options.timeoutMs ?? 30000,
    onChange: (value) => updates.push(value),
    release: (page) => released.push(page),
    load: (key, signal) => {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => {
        const job = { key, signal, resolve, reject };
        jobs.push(job);
        if (options.honorAbort !== false)
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }).finally(() => {
        active--;
      });
    },
  });
  t.after(() => cache.clear());
  async function finish(key) {
    const job = jobs.findLast((job) => job.key === key);
    const page = { url: `blob:page-${key}`, bytes: key + 100 };
    job.resolve(page);
    await tick();
    return page;
  }
  return { cache, jobs, released, updates, finish, maximum: () => maximum };
}

test("不翻页也连续预加载整部，每完成一张再加载下一张，已加载数据可直接复用", async (t) => {
  const { cache, jobs, finish, maximum } = setup(t, [0, 1, 2, 3, 4, 5]);
  const first = cache.show(0);
  await tick();
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0],
  );
  const firstPage = await finish(0);
  assert.equal(await first, firstPage);
  for (let key = 1; key <= 5; key++) {
    assert.deepEqual(
      jobs.map((job) => job.key),
      Array.from({ length: key + 1 }, (_, index) => index),
    );
    await finish(key);
  }
  assert.equal(maximum(), 1);
  assert.deepEqual(cache.stats(), {
    ready: 6,
    total: 6,
    pending: 0,
    failed: 0,
    bytes: 615,
  });
  assert.equal(await cache.show(0), firstPage);
  assert.equal(cache.peek(0), firstPage);
  assert.equal(jobs.length, 6);
});

test("从中间页开始，预加载到末尾后补齐前面的页面，使用实际的不连续索引", async (t) => {
  const { cache, jobs, finish } = setup(t, [2, 7, 11, 20]);
  const selected = cache.show(11);
  await tick();
  await finish(11);
  await selected;
  await finish(20);
  await finish(2);
  await finish(7);
  assert.deepEqual(
    jobs.map((job) => job.key),
    [11, 20, 2, 7],
  );
  assert.equal(cache.stats().ready, 4);
  await assert.rejects(cache.show(0), /无效/);
});

test("翻到正在预加载的页面会复用同一请求，不重复下载", async (t) => {
  const { cache, jobs, finish } = setup(t, [0, 1, 2]);
  const first = cache.show(0);
  await tick();
  await finish(0);
  await first;
  const next = cache.show(1);
  const repeated = cache.show(1);
  assert.equal(next, repeated);
  const page = await finish(1);
  assert.equal(await next, page);
  assert.equal(jobs.filter((job) => job.key === 1).length, 1);
});

test("跳页优先加载目标页，取消的后台页随后继续；已缓存页面不重新下载", async (t) => {
  const { cache, jobs, finish, maximum } = setup(t, [0, 1, 2, 3, 4]);
  const first = cache.show(0);
  await tick();
  const firstPage = await finish(0);
  await first;
  const target = cache.show(4);
  assert.equal(jobs[1].signal.aborted, true);
  await tick();
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0, 1, 4],
  );
  await finish(4);
  await target;
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0, 1, 4, 1],
  );
  await finish(1);
  await finish(2);
  await finish(3);
  assert.equal(await cache.show(0), firstPage);
  assert.equal(maximum(), 1);
  assert.equal(cache.stats().failed, 0);
  assert.equal(cache.stats().ready, 5);
});

test("快速跳走再跳回，已取消请求的完成不能覆盖同页新请求", async (t) => {
  const { cache, jobs, finish } = setup(t, [0, 1, 2]);
  const old = cache.show(0);
  await tick();
  const other = cache.show(2);
  const back = cache.show(0);
  await assert.rejects(old, { name: "AbortError" });
  await tick();
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0, 0],
  );
  const page = await finish(0);
  assert.equal(await back, page);
  await finish(1);
  await finish(2);
  assert.equal(await other, cache.peek(2));
});

test("预加载失败不会卡住整部，选到失败页时可以重新获取", async (t) => {
  const { cache, jobs, finish } = setup(t, [0, 1, 2]);
  const first = cache.show(0);
  await tick();
  await finish(0);
  await first;
  jobs[1].reject(new Error("临时失败"));
  await tick();
  await finish(2);
  assert.equal(cache.stats().failed, 1);
  assert.equal(cache.stats().ready, 2);
  const retry = cache.show(1);
  await tick();
  await finish(1);
  await retry;
  assert.equal(cache.stats().failed, 0);
  assert.equal(cache.stats().ready, 3);
});

test("单页超时也会继续后续预加载，不永久占住队列", async (t) => {
  const { cache, jobs } = setup(t, [0, 1], { timeoutMs: 10 });
  await assert.rejects(cache.show(0), { name: "TimeoutError" });
  await tick();
  assert.equal(jobs[0].signal.aborted, true);
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0, 1],
  );
  assert.equal(cache.stats().failed, 1);
});

test("重试失败页只补失败项，不丢弃已下载缓存，重复点击不会重复排队", async (t) => {
  const { cache, jobs, finish, maximum } = setup(t, [0, 1, 2, 3]);
  const first = cache.show(0);
  await tick();
  const cover = await finish(0);
  await first;
  jobs[1].reject(new Error("下载失败"));
  await tick();
  await finish(2);
  jobs[3].reject(new Error("下载失败"));
  await tick();
  assert.equal(cache.stats().failed, 2);
  cache.retryFailed();
  cache.retryFailed();
  await tick();
  await finish(1);
  await finish(3);
  assert.deepEqual(
    jobs.map((job) => job.key),
    [0, 1, 2, 3, 1, 3],
  );
  assert.equal(cache.peek(0), cover);
  assert.equal(cache.stats().ready, 4);
  assert.equal(cache.stats().failed, 0);
  assert.equal(maximum(), 1);
});

test("解码失败可以废弃对应 Blob 后重新下载，其他缓存保持可用", async (t) => {
  const { cache, released, finish } = setup(t, [0, 1]);
  const first = cache.show(0);
  await tick();
  const cover = await finish(0);
  await first;
  const failedPage = await finish(1);
  cache.invalidate(1);
  assert.equal(cache.stats().ready, 1);
  assert.equal(cache.stats().failed, 1);
  assert.deepEqual(released, [failedPage]);
  assert.equal(cache.peek(0), cover);
  const retried = cache.show(1);
  await tick();
  const restored = await finish(1);
  assert.equal(await retried, restored);
  assert.equal(cache.stats().failed, 0);
});

test("退出立即停止队列并释放全部缓存，迟到的数据也释放且不更新旧页面", async (t) => {
  const { cache, jobs, finish, released, updates } = setup(t, [0, 1, 2], {
    honorAbort: false,
  });
  const first = cache.show(0);
  await tick();
  await finish(0);
  await first;
  cache.clear();
  assert.equal(jobs[1].signal.aborted, true);
  assert.equal(released.length, 1);
  const updateCount = updates.length;
  await finish(1);
  assert.equal(jobs.length, 2);
  assert.equal(released.length, 2);
  assert.equal(updates.length, updateCount);
  assert.equal(cache.stats().ready, 0);
  cache.clear();
  assert.equal(released.length, 2);
  await assert.rejects(cache.show(0), { name: "AbortError" });
});

test("图片数据缓存读取 Blob 并生成本地 URL，不附带外部认证凭据", async (t) => {
  const controller = new AbortController();
  let options;
  let cachedBlob;
  t.mock.method(globalThis, "fetch", async (_, requestOptions) => {
    options = requestOptions;
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/webp" },
    });
  });
  t.mock.method(URL, "createObjectURL", (blob) => {
    cachedBlob = blob;
    return "blob:test-page";
  });
  const page = await loadReaderPage(
    async () => "https://storage.example/page",
    controller.signal,
  );
  assert.deepEqual(page, { url: "blob:test-page", bytes: 3 });
  assert.equal(cachedBlob.type, "image/webp");
  assert.equal(options.credentials, "omit");
  assert.deepEqual(options.headers, {});
});

test("HTTP 错误和空图片不能计入已缓存，取消后不创建对象 URL", async (t) => {
  let objectUrls = 0;
  t.mock.method(URL, "createObjectURL", () => {
    objectUrls++;
    return "blob:test";
  });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("error", { status: 403 }),
  );
  const controller = new AbortController();
  await assert.rejects(
    loadReaderPage(
      async () => "https://storage.example/page",
      controller.signal,
    ),
    /403/,
  );
  fetchMock.mock.mockImplementation(async () => new Response(""));
  await assert.rejects(
    loadReaderPage(
      async () => "https://storage.example/page",
      controller.signal,
    ),
    /为空/,
  );
  controller.abort();
  await assert.rejects(
    loadReaderPage(
      async () => "https://storage.example/page",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(objectUrls, 0);
});

import { ApiError, dmb } from "./entry-api.js";
import { timestampNanos } from "./pending-comics.js?v=queue-status-1";

// QueryByStatus accepts one status per request; never scan the archived library.
export const DOWNLOAD_STATUSES = [
  "downloading",
  "resolving",
  "queued",
  "failed",
  "deleted",
  "purged",
];

export function downloadProgress(document) {
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const done = valid(document.progress?.done) ? document.progress.done : null;
  const total =
    valid(document.progress?.total) && document.progress.total > 0
      ? document.progress.total
      : null;
  return {
    done,
    total,
    percent:
      done !== null && total !== null
        ? Math.min(100, Math.round((done / total) * 1000) / 10)
        : null,
  };
}

export async function readDownloadDocuments(base, { signal } = {}) {
  const controller = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const groups = await Promise.all(
      DOWNLOAD_STATUSES.map(async (status) => {
        const records = [];
        const seen = new Set();
        let offset = 0;
        while (true) {
          requestSignal.throwIfAborted();
          const { data } = await dmb(base, "/v1/documents/query", {
            method: "POST",
            signal: requestSignal,
            body: {
              mode: "by_status",
              params: { status },
              orderby: "id",
              order: "DESC",
              limit: 100,
              offset,
            },
          });
          if (
            !Array.isArray(data) ||
            data.length > 100 ||
            data.some(
              (row) =>
                !row ||
                !Number.isSafeInteger(row.document_id) ||
                row.document_id < 0 ||
                ![...DOWNLOAD_STATUSES, "archived"].includes(row.status),
            )
          )
            throw new ApiError(
              "DMB 返回了无效的下载记录。",
              "INVALID_RESPONSE",
            );
          let added = 0;
          for (const row of data) {
            if (!seen.has(row.document_id)) added++;
            seen.add(row.document_id);
            records.push(row);
          }
          if (data.length < 100) break;
          if (!added)
            throw new ApiError(
              "DMB 分页未向后推进，稍后自动重试。",
              "INVALID_RESPONSE",
            );
          offset += data.length;
        }
        return records;
      }),
    );
    requestSignal.throwIfAborted();
    const documents = new Map();
    for (const row of groups.flat()) {
      const previous = documents.get(row.document_id);
      if (
        !previous ||
        (timestampNanos(row.updated_at) ?? 0n) >=
          (timestampNanos(previous.updated_at) ?? 0n)
      )
        documents.set(row.document_id, row);
    }
    return [...documents.values()]
      .filter((row) => row.status !== "archived")
      .sort(
        (a, b) =>
          DOWNLOAD_STATUSES.indexOf(a.status) -
            DOWNLOAD_STATUSES.indexOf(b.status) ||
          b.document_id - a.document_id,
      );
  } finally {
    // A failed page also cancels the other status queries in this refresh.
    controller.abort();
  }
}

export function pollDownloads(
  base,
  { signal, onData, onError, read = readDownloadDocuments },
) {
  if (signal?.aborted) return () => {};
  const controller = new AbortController();
  let busy = false;
  async function refresh() {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      const documents = await read(base, { signal: controller.signal });
      if (!controller.signal.aborted) onData(documents);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(refresh, 1000);
  function stop() {
    clearInterval(timer);
    controller.abort();
    signal?.removeEventListener("abort", stop);
  }
  signal?.addEventListener("abort", stop, { once: true });
  void refresh();
  return stop;
}

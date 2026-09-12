# 前端状态与异常处理

## 漫画库与详情状态

- `comic-library.js` 负责查询参数与 URL 往返、读取原始 Comic、解析标签关系和 DMB 页索引。
- `library-page.js` 管理已应用查询、输入框草稿和标签候选。候选选择只修改草稿，
  提交后写入 hash 并重新查询；URL 是已应用条件和分页的恢复依据。
- 标签候选跨分类查询与详情读取均采用有限并发。当前页来源标签先按完整身份去重，
  对应的 GenericTag ID 查询也去重；每次刷新重新读取，避免缓存已变化的关系。
- 漫画原始字段先展示，封面和通用标签异步补充。外部图片或部分标签不可用时，
  保留漫画与其他已经取得的字段，并提供局部重试。
- `comic-detail.js` 通过单本 GET 读取 CM 元数据，再并行补齐标签和 DMB 归档，只加载封面。
  来源与封面失败保留已经显示的 CM 数据，提供各自的重试。每次进入创建独立状态，
  页面与局部请求的取消信号共同控制请求；旧状态或已取消请求的结果不能覆盖当前详情。
- `comic-links.js` 负责详情链接和阅览器 URL。阅览器地址保存在
  `localStorage["comicmanager.viewerUrl"]`，默认为 `/dmb-viewer.html`。
  保存前校验协议与凭据，使用 URL 查询参数设置 DMB ID；变更配置只更新当前详情的阅览链接。
- 图片 URL 通过 DMB 的 `?url=1` 纯文本接口获取，图片线路保存在
  `localStorage["comicmanager.imageRoute"]`（`proxy` / `direct`，默认 `proxy`）。
  切换线路取消旧签发和图片请求，漫画库与详情页只重载封面，不重建检索表单。
  签发请求禁止跟随重定向，返回内容必须是无嵌入凭据的 HTTP / HTTPS URL。
- 页面路由统一取消上一个页面的请求。检索结果分页超出末页时替换为有效末页，
  不新增多余的浏览器历史记录。

## 独立阅览器缓存

- `dmb-viewer.js` 为每次阅读创建独立会话，文档查询与当前页解码分别具有取消信号；
  翻页递增显示版本，迟到的响应不能覆盖当前页。Viewer.js 与主图共用缓存对象 URL。
- `viewer-image-cache.js` 按实际页面索引维护串行队列，跳页可以抢占后台预读。
  同页复用请求和已下载 Blob；单页失败或超时继续队列，解码失败只废弃对应缓存。
  手动重试失败项保留其余成功项，不重复排队。进度统计包含就绪、待处理、失败页数和字节数。
- 缓存只在本次阅读内存中保存。`pagehide` 取消请求、销毁放大层并释放所有对象 URL；
  离开后才完成的 Blob 同样释放。`pageshow` 恢复页面时重新读取文档并从原页开始缓存。
- Viewer.js 固定沿用 1.11.6，按其[公开方法](https://github.com/fengyuanchen/viewerjs/blob/v1.11.6/README.md#methods)
  接入：保留主图 DOM，仅更换 `src` / `alt` 后调用 `update()`；先 `hide(true)`、`destroy()`，
  再释放 Blob。框架的放大层复制主图 URL，`navbar: false` 不加载缩略图，缓存队列不接管其内部列表。

## 页面状态

`pending-comics.js` 负责 anchor / 全量扫描、时间比较、队列合并排序和提交完成核对。
`manager.js` 持有来源摘要与 CM 映射，扫描成功后一次性合并；取消或失败不替换原队列。
队列摘要按 DMB 地址存到 localStorage，刷新后默认 anchor 扫描，并用新读取的 CM 清除完成项。
比较部分 DMB 结果时不把未扫描的 CM 记录判为来源缺失。
Anchor 每轮并行请求 CM、DMB 各 100 条，分别按 ID 倒序、更新时间倒序累积匹配。
遇到可确认完成的记录并读完其更新时间组后停止；CM 尚未覆盖的 ID 保持“尚未核对”。
再次扫描只合并原来的待处理记录，不能把上次全量扫描已完成的条目因 CM 尚未读到而重新入队。

单本工作台用 `GET /api/comics/{id}` 读取当前 Comic，不重新加载 CM 列表。
CM 映射中的 `null` 表示该 ID 已明确返回 `COMIC_NOT_FOUND`；不存在的键表示还未读取，
结合扫描覆盖范围判断“尚未核对”。缺失项不计入已读取的 CM 记录数。
`refreshIds` 记录需要重新确认的漫画；单本提交失败或完成核对失败后，返回队列及继续录入
只重读这些 ID 的 CM / DMB 详情，成功后才清除标记。重查失败或取消时不推进队列。
提交完成核对也按 ID 查询，标题变化和同名漫画不再需要分页查找。

`batch-entry.js` 始终按整条队列的 DMB 更新时间从早到晚执行；列表筛选不传入执行器。
单部精确标签查询最多 6 路，全部结束后才决定是否写入。每次提交后读取持久化 CM 与当前
DMB，确认完成再继续；任一阻断或失败都会停止，不越过当前部。

运行期间用 `pendingWrites` 锁定其他写操作和路由跳转。停止请求仅在漫画之间检查，
不取消可能已经落库的写请求。已确认成功的条目立即从队列移除并保存，结束时再刷新 CM。
手动入口也只允许打开队首；成功页提供“处理下一部”，提交失败仍停留在当前漫画。

原生 JavaScript 第一版建议维护一个单一页面状态对象：

```js
const state = {
  phase: 'loading',
  comicId: null,
  groups: [],
  preview: null,
  tagItems: [],
  activeIndex: null,
  pendingRequestCount: 0,
  sessionCreatedGenericTags: [],
  sessionCreatedSpecificTags: [],
  globalError: null
};
```

`phase` 可取：

```text
loading
resolving
ready-to-commit
committing
success
already-exists
fatal-error
```

## 单个标签状态

```js
{
  specificTag: {},
  status: 'loading',
  exactMapping: null,
  candidates: [],
  selectedGroup: null,
  selectedGenericTag: null,
  error: null
}
```

`status`：

```text
loading
resolved
recommended
unresolved
saving
error
```

不要把 DOM 当作权威状态。每次 API 响应先更新 state，再由统一 render 函数更新
对应区域。

## 派生状态

以下状态不单独存储，由 `tagItems` 计算：

```js
const unresolvedCount = tagItems.filter(
  item => item.status !== 'resolved'
).length;

const canCommit =
  unresolvedCount === 0 &&
  pendingRequestCount === 0 &&
  phase === 'resolving';
```

避免同时维护 `resolvedCount`、`unresolvedCount` 和每行状态造成不一致。

## 请求并发

preview 后的 exact 查询采用有限并发，不使用无上限 `Promise.all()`。

建议：

- 同时最多 6 个 SpecificTag 查询。
- GenericTag 搜索输入使用 250–350ms debounce。
- 新搜索开始时通过 `AbortController` 取消旧请求。
- 写请求期间禁用当前标签的所有映射操作。
- Comic commit 期间禁用全页面写操作。

## 请求去重

同一 preview 中可能出现重复 SpecificTag。前端可以按服务端返回对象的稳定序列化
结果去重查询，但不得以去重结果改变 Comic 的原始标签列表。

即使前端做了去重，服务端 commit 仍需独立验证。

## 错误处理

### 网络错误

保留用户当前状态，只将相关标签标为 `error`。提供单行重试，不重新加载整个页面。

### `GENERIC_TAG_EXISTS`

用提交的 tag_group 和 name 精确查询 GenericTag ID，按需读取详情，再继续创建映射。

### `SPECIFIC_TAG_MAPPING_CONFLICT`

停止当前保存，重新执行该标签的 exact 查询取得 ID，再读取 `/generic` 关系：

- 如果已经映射到用户刚选择的 GenericTag，视为成功。
- 如果映射到其他 GenericTag，显示冲突双方，不自动覆盖。

### `META_SCHEMA_VIOLATION`

该错误不能由普通用户在页面中修复。阻断当前标签，展示 site、origin_name、
服务端 schema hash 和模型 schema hash，并要求维护者介入。

### 提交时的来源数据

commit 不需要预览版本，始终从 DMB 重新读取最新 metadata。标题、作者和已映射标签的变化
直接使用最新内容；如新增标签尚未映射，则按 `UNMAPPED_SPECIFIC_TAGS` 处理。
已写入数据库的 Tag 映射不会因漫画提交失败回滚，重新精确查询时继续复用。

### `UNMAPPED_SPECIFIC_TAGS`

这通常意味着 preview 后 metadata 变化，或者其他操作改变了映射状态。

用响应中的缺失 SpecificTag 定位对应行，并重新执行 exact/same-origin 查询。
不要直接重试 commit。

## 页面恢复

第一版不保存服务端草稿。刷新页面时重新 preview 并精确查询全部标签。

因为 GenericTag 和 SpecificTag 映射是独立项目资源，已经成功写入的操作会被重新
识别，不需要在浏览器中恢复。

可以使用 `sessionStorage` 记住以下纯界面状态：

- 当前选中的标签 index。
- 左侧筛选条件。
- metadata 折叠状态。

不得把未提交的映射选择当成可靠草稿写入 `localStorage`。

## 安全与输出

- 所有名称和 metadata 以 `textContent` 渲染。
- 不将来源 metadata 拼接进 `innerHTML`。
- 外部 URL 必须验证协议，只允许预期的 `http`/`https` 或站内相对路径。
- 错误详情默认折叠，避免将服务端堆栈直接展示给普通用户。
- 客户端校验只改善体验，所有身份、枚举和唯一性约束仍由服务端验证。

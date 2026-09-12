# ComicManager 前端设计总览

本文档记录 ComicManager 新版 Web 前端的既定设计。目标是在后续上下文丢失、
更换实现者或继续重构时，仍能恢复当前的架构边界和交互意图。

最后更新：2026-09-12。

## 当前实现与运行

- 首页漫画库：`/exploror#/`，展示封面、标题、作者和标签，支持组合检索与分页。
- 录入入口：`/exploror#/entry`，只进入待处理队列中最早的一部。
- 录入工作台：`/exploror#/entry/{comic_id}`。
- 漫画详情：`/exploror#/comic/{comic_id}`，展示元数据、标签与封面，通过「阅览」跳转至独立阅览器。
- 待处理队列：`/exploror#/pending`，默认 anchor 扫描，也可手动全量扫描；筛选与分页只用于查看。
- 下载进度：`/exploror#/downloads`，每秒刷新排队中、解析中、下载中和 failed 记录，展示页数、百分比及失败原因。
- 通用标签管理：`/exploror#/tags`，支持分类搜索、新建标签、查看来源映射及分页。
- 管理页面沿用 `/exploror` 和 `/src/{filename}` 路由，数据接口保持不变。
  `GET /dmb-viewer.html` 提供自带阅览器静态页面，沿用现有身份验证。
- 使用原生 JavaScript 模块与本地 Bootstrap 5.3.8 资源，无前端构建步骤。
- 默认 DMB 地址为 `https://dmb.khadas.hayaseyuuka.date:8880`，浏览器只以 `viewer`
  读取归档。连接设置只改变浏览器的 DMB 地址；应与后端 `DMB_URL` 保持一致。
- 连接设置提供「图片线路」：默认「代理」使用签发原地址；「8880 直连」将已知存储入口
  `https://dmb-oss.hayaseyuuka.date` 替换为 `https://dmb-oss.khadas.hayaseyuuka.date:8880`，
  完整保留路径与签名参数。选择保存在浏览器，用于漫画库与详情页封面，不影响归档 API 地址。
- 连接设置提供「阅览器地址」，默认 `/dmb-viewer.html`。独立阅览器自行管理其 DMB 连接和图片行为。
- 本地联调使用 `http://localhost:8000`。该 Origin 在当前 DMB CORS 白名单中；
  `http://127.0.0.1:8000` 与其他端口是不同的 Origin。

临时库启动示例（在项目根目录运行）：

```sh
comic_test_dir=$(mktemp -d)
export COMIC_DB_PATH="$comic_test_dir/comics.db"
export DMB_URL='https://dmb.khadas.hayaseyuuka.date:8880'
.venv/bin/python - <<'PY'
import os, sqlite3
from contextlib import closing
from pathlib import Path
with closing(sqlite3.connect(os.environ['COMIC_DB_PATH'])) as conn:
    conn.executescript(Path('comic.sql').read_text())
PY
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
```

前端回归测试：`node --test tests/*.test.mjs`。不要直接执行根目录旧的
`test_comics.py` / `test_tags.py` 做自动测试，它们包含对真实数据库的录入操作。

Bootstrap 文件保留上游 MIT 许可证头，来自
[官方 5.3 下载说明](https://getbootstrap.com/docs/5.3/getting-started/download/)，下载时已校验官方 SHA-384。

## 阅读顺序

1. [API 对接约定](api-contract.md)
2. [漫画录入流程](comic-entry-flow.md)
3. [页面与交互规格](ui-spec.md)
4. [前端状态与异常处理](frontend-state.md)

## 项目边界

Tag 是整个 ComicManager 的一级资源，不是漫画录入流程的内部数据。

API 分为两个资源域：

- `/api/tags` 管理 TagGroup、GenericTag、SpecificTag 及它们的映射关系。
- `/api/comics` 负责已入库漫画的分页读取、组合检索、预览和提交。

不建立 `/api/comic-imports` 这一类只服务于归一化页面的专用资源。漫画录入页面
只是 `/api/tags` 和 `/api/comics` 的一个客户端。

后端直接返回现有 GenericTag、SpecificTag、Comic 模型，标签查询接口返回 ID 数组，
漫画查询接口返回原始 Comic 数组。
前端按需读取详情、映射关系及 DMB 来源信息，自行组织候选和汇总，不要求后端
为页面增加展示模型或拼装关联数据。具体返回结构以 API 对接约定为准。

## 已确定的核心规则

1. `SpecificTag` 的身份由 `site + origin_name + canonical meta_json` 决定。
2. 一个 `SpecificTag` 必须且只能映射到一个 `GenericTag`。
3. 多个不同 metadata 的 `SpecificTag` 可以映射到同一个 `GenericTag`。
   Hitomi 的 male/female 同名 tag 就属于这种情况。
4. `GenericTag` 是不同来源标签的最大公约数；需要细粒度信息时直接查询
   `SpecificTag`。
5. Hitomi 原始 group 保留为字符串。无法推断 `TagGroup` 时必须人工选择，
   不允许自动 fallback 到 `tag`。
6. `GET /api/comics/{comic_id}/preview` 负责读取归档 metadata，并由服务端
   `SiteHandler` 提取 Comic 和 SpecificTag。
7. 前端通过通用 Tag API 查询和补齐映射。
8. `POST /api/comics/{comic_id}/commit` 不接收映射决定。它重新读取来源数据，
   并在所有 SpecificTag 已经具有唯一映射时才录入漫画。
9. Comic commit 必须是单一数据库事务；失败时不得留下部分 Comic 数据。

## 下载进度观察

- 独立栏目 `#/downloads`，与待处理录入队列分别维护状态。
- 使用 DMB 现有 `POST /v1/documents/query`，`mode=by_status`、`params.status` 每次指定
  一个状态；每轮并行查询 downloading、resolving、queued、failed，
  各状态按 ID 倒序分页读取全部结果，每页 100 条，不查询 archived、deleted、purged 或 CM 漫画列表。
- 进入立即刷新，此后每秒启动一轮；上一轮未结束时跳过本次，避免请求叠加。
  离开栏目、关闭页面、暂停刷新或切换 DMB 地址时取消计时器与在途请求；旧响应不覆盖新页面。
- 使用原始 `progress.done / progress.total` 显示已下载页数和百分比。
  总页数未知时不显示虚假的 0% 或 100%；failed 保留已完成进度并可展开原始 `error` 文本。
- 下载中优先显示，其余按状态分组、组内 ID 倒序；状态切换时按最新记录去重，
  已归档、已删除和已清理条目在后续刷新中自动移出。刷新时保留已展开的失败详情。
- 请求失败保留上次结果，显示失败提示并在下一轮自动重试；整轮成功才替换列表。
- 全程使用 viewer 只读接口，不触发下载、重试下载、删除或录入操作。

## 待处理队列与扫描

- 打开队列默认 anchor 扫描，每轮并行读取 CM、DMB 各 100 条，在本地累积比对。
  CM 使用 `POST /api/comics/query` 按 ID 倒序，DMB 使用 `mode=all, orderby=updated_at, order=DESC`。
  按 DMB 顺序找到 CM 已存在且 `CM.updated_at > DMB.updated_at` 的记录即确定 anchor。
  相同更新时间的一组读完后才停止，不依赖 DMB 未约定的第二排序键。
- 两边分页不要求 ID 对齐，新分页会与之前已读取的记录一起匹配。
  尚未覆盖到的 CM ID 标作“CM 尚未核对”，不会当作确定未入库，也不为此预读全库。
  页面分别显示本次读取量和 CM 总数。
- 没有 anchor 则遍历全部活动记录。手动“全量扫描”保留原来的活动、deleted、purged 分页读取。
- 两种扫描都把发现的未完成记录按 ID 去重后合并进队列，不覆盖已经排队的记录。
  CM 的持久化时间严格更晚才移出队列；相同、缺失或无效时间不会当作完成。
- 队列按 DMB 更新时间升序，同时间按 ID 升序；只提供一个“处理下一部”入口。
  归档失败、已删除和已清理的记录不出现在待处理列表，也不作为 anchor 或参与自动录入。
  扫描发现状态变更后从队列移除；恢复缓存时也排除这些状态。
  不支持的来源或缺少 metadata 的活动记录保留在队首并显示原因。
- 队列摘要按 DMB 地址保存在 `localStorage["comicmanager.entryQueue:" + dmbUrl]`。
  刷新后进行分批 anchor 扫描；存储不可用时仍支持本页面内的队列。
- 列表搜索、状态/原因筛选、分页都只改变展示，不能改变手动或自动录入的队首。
  旧的任意 ID 录入链接只有在目标是当前队首时才可打开，否则返回队列。
- 扫描完成后才合并新结果；失败、取消或离开页面时保留原队列，不加入部分结果。
  这里不实现历史空洞的自动补扫；由用户决定何时触发全量扫描。
- 打开单本工作台通过 `GET /api/comics/{id}` 查询当前漫画，保留其他漫画的扫描结果。
  仅 404 `COMIC_NOT_FOUND` 视为未入库；鉴权、网络及其他错误需要重试。
- 每次提交后，通过 `GET /api/comics/{id}` 读取持久化 Comic，并重新读取对应 DMB 记录，
  按相同完成规则决定是否移出队列。commit 返回体中的空时间不作为完成依据。
- 单本提交或确认失败时记录具体 ID，继续录入或返回队列只重查受影响的漫画。
  取消或失败不会清除重查标记，也不会推进到下一部。

## 按队列自动录入

- 点击“自动录入”才执行，始终从整个队列最早的一部开始，不受列表筛选影响。
- 全部标签已映射则直接 commit；仅有 group 未映射时，按 `origin_name` 创建或复用
  同组同名 GenericTag，建立并确认映射后 commit。保留完整 SpecificTag 身份。
- 存在其他未映射标签时不提前创建 group，停在当前部等待手动处理。
  查询错误、映射冲突、并发录入冲突、提交后确认失败也会停止，后续漫画继续等待。
- 队列同时包含未入库和需要更新的漫画；前者默认新增，后者使用 `allow_override=true`。
  手动录入仍经过复核，复核页明确提示更新范围。
- 单部与批量 commit 均无需请求体，使用 DMB 最新数据，不依赖预览版本。
- 成功确认一部后才继续下一部；停止按钮完成当前部后生效。运行期间锁定其他写操作、
  路由和扫描；显示当前漫画、成功/待处理/失败计数和逐部结果。
  失败前已保存的 group 映射保留，下次会重新查询并复用。

## 漫画库与检索

- 展示、检索和阅读是主流程，录入与未完成列表为辅助入口。
- 通过 `POST /api/comics/query` 按标题、作者及通用标签 ID 组合检索，使用响应头
  `X-Total-Count` 分页。漫画库默认传 `order: "DESC"`，按 ID 倒序排列，筛选后也沿用此顺序。
  默认每页 20 部，可切换 50 / 100 部；顶部和底部均可输入页码跳转。
- 标题默认包含匹配，作者默认精确匹配；均可选择包含、精确、前缀。匹配区分大小写。
- 标签使用单个多选输入框：输入文字后跨分类提示包含该文字的 GenericTag，点选后变成
  框内可移除的标签块，并可继续输入。相同名称显示分类以区分；支持方向键、Enter、Escape
  及空输入时 Backspace 删除最后一个标签。选好后点击“检索”应用条件。
- 提示查询每个分类最多读取 12 项，超出时提示继续输入缩小范围。输入防抖 280ms，
  新输入、失焦和离开页面时取消旧查询，中文输入法组合期间不提交中间文字。
- 多标签支持全部满足 / 任一满足；标签、作者和标题三类条件之间取交集。
- 点击漫画的作者或标签可立即进一步筛选。封面和标题进入详情；“整理”为次要操作。
- 漫画保留完整原始字段。浏览器对当前页的来源标签去重，分别查询精确身份、GenericTag
  关系及 ID，按通用标签去重展示；不要求后端提供 View 或预先拼装关联。
- DMB 元数据和图片单独读取；某个来源或标签读取失败不会阻止其余漫画展示。
- `title`、`author`、`tags`、匹配方式、`page`、`size` 保存于 hash 查询参数中，
  刷新及浏览器前进/后退均会恢复；详情和整理链接携带返回查询，返回时重新读取漫画库。
- 从漫画库进入整理时识别已有记录，在复核页明确提示更新，用户确认后才覆盖。

## 漫画详情与独立阅览器

- 详情通过 `GET /api/comics/{id}` 读取单部 Comic，先展示标题、作者、系列、卷号和更新时间，
  再独立补齐通用标签与对应 DMB 归档信息，不扫描 CM 列表。来源或标签失败只影响对应区域，支持局部重试。
- 标签按分类展示，作者和标签链接保留原检索条件并进一步筛选；原始 CM、DMB 和来源标签可展开查看。
- 详情只加载实际页面索引最小的一张作为封面。先读取
  `/v1/documents/{id}/pages/{index}?url=1&token=viewer` 的纯文本签发 URL，再按图片线路设置加载。
  直连替换依赖当前 Nginx 网关还原签发 Host；其他存储域名原样使用，签发 URL 不写入本地存储。
- 「阅览器地址」保存在 `localStorage["comicmanager.viewerUrl"]`，支持 HTTP / HTTPS 地址和本站根路径，
  留空恢复 `/dmb-viewer.html`。默认值保留为相对路径，换域名访问时仍使用当前站点。
- 「阅览」在当前标签页直接打开配置地址，查询参数 `id` 使用 Comic ID（即 DMB ID），
  不使用来源站点的 document ID。已有 `id` 会替换，其他查询参数和 fragment 保留。
- 原 `#/read/{id}` 链接兼容转到详情，保留返回漫画库的查询条件。CM 内嵌阅读、翻页和整部缓存逻辑已移除。
- 自带阅览器沿用 `templates/dmb-viewer.html` 和 `src/dmb-viewer.js`，独立负责翻页、图片加载及其连接配置；
  CM 的连接设置只决定跳转地址与 CM 自身的来源读取、封面线路。
- 自带阅览器保留 Viewer.js 的放大、旋转功能，`viewer-image-cache.js` 逐张下载整部图片，
  从当前页读到末尾后补齐前面的页面；跳到未缓存页时优先加载目标，随后继续后台队列。
  已下载图片以 Blob 和对象 URL 保留到本次阅读结束，回翻与放大直接复用；只解码当前显示图片。
- 页码右侧显示已缓存页数、容量、预加载状态、失败页数和进度条，工具栏保持单行。单页失败或 30 秒超时继续后续页，
  失败页可单独重试；队列结束后也可点击「重试失败页」补齐，不重新下载成功项。
- 退出或刷新时取消文档、签发、图片与解码请求，销毁 Viewer.js 并释放全部对象 URL。
  浏览器后退恢复阅览器时从原页重新建立本次缓存；签发 URL 与图片不写入本地存储。

## 领域词汇

- **GenericTag**：跨站点使用的通用标签，例如 `tag / glasses`。
- **SpecificTag**：携带站点原始 metadata 的来源标签。
- **精确映射**：数据库中存在完整 SpecificTag 身份对应的记录。
- **相似标签**：`site + origin_name` 相同，但 metadata 不同的 SpecificTag。
- **候选目标**：相似 SpecificTag 当前映射到的 GenericTag。
- **组选择**：用户根据原始 SpecificTag 信息选择的 GenericTag 分类。
- **待处理标签**：尚不存在精确映射的 SpecificTag。

## 相关源码

- [`tags.py`](../../tags.py)：Tag 领域模型和数据库操作。
- [`comics.py`](../../comics.py)：Comic 模型、预览构造与录入逻辑。
- [`handlers.py`](../../handlers.py)：站点 metadata 解析。
- [`comic.sql`](../../comic.sql)：Tag 和 Comic 数据库约束。
- [`test_comics.py`](../../test_comics.py)：当前 CLI 录入流程的行为基线。

# hexo-editor GitHub 模式改造方案

> 状态：草案 v1，待确认后实施
> 范围：`tools/hexo-editor`（编辑器）＋ 博客仓库的分支策略 ＋ Netlify 构建配置
> 不在范围内：Hexo 主题、文章内容、Waline

---

## 1. 目标与边界

### 1.1 目标

1. 编辑器除了现有的本地目录模式，新增 GitHub 仓库模式。
2. 启动时弹窗选择「本地目录 / GitHub 仓库」，本地模式行为完全不变。
3. GitHub 模式下：草稿存在 `draft/<abbrlink>` 分支，正式发布合并到 `main`。
4. `main` 只读，所有修改必须经过草稿分支。
5. 每次发布 = 一次 commit = 一次 Netlify 构建；支持多篇草稿一次发布。
6. 编辑器负责分配 `abbrlink`，不依赖 `hexo generate` 回写。
7. 提供图片管理：列表、按需预览、上传、删除、一键清理孤儿图。

### 1.2 边界

- 编辑器不运行 Hexo、不做站点预览。
- 不做图片重命名 / 移动。
- 不做在线多人协作；冲突一律拒绝并提示，不自动合并。
- GitHub 模式只在 `zerokami.cn/tools/hexo-editor` 下可用（原因见 §3.3）。

---

## 2. 总体架构

```
浏览器（编辑器）
  │  同域 fetch，带 httpOnly cookie
  ▼
Netlify Function  /api/github/*
  │  注入 App token，代理 GitHub API
  ▼
GitHub API  api.github.com
  │
  ├─ main            已发布（只读）
  └─ draft/<abbrlink> 草稿分支（一稿一支）
        │
        │ 发布：差量 tree 合并（一次 commit）
        ▼
      main ──→ Netlify 构建 ──→ zerokami.cn
```

关键约束：

- 浏览器不直接持有 GitHub token，所有请求经 Function 代理。
- 发布使用 Git Data API 构造一次 commit，不用多次 merge。
- 草稿分支落后于 main 不会回退其他文章（差量 tree 只覆盖变更文件）。

---

## 3. 认证与安全

### 3.1 方式

GitHub App + Netlify Function，用户级授权（user-to-server token）。

**App 权限**：

| 权限 | 级别 | 用途 |
|---|---|---|
| Contents | Read and write | 读写文章、图片、分支、commit |
| Metadata | Read | 必选基线 |
| Pull requests | 不需要 | 不建 PR，直接更新 ref |
| Actions / Workflows / Secrets | 不需要 | — |

**安装范围**：仅 `XieYu-Zk/zerokami` 一个仓库。

### 3.2 流程

1. 用户点「连接 GitHub」→ 跳转 `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=https://zerokami.cn/.netlify/functions/github-auth-callback`
2. 回调 Function 用 `client_id + client_secret + code` 换 token
3. token 写入 `HttpOnly; Secure; SameSite=Lax; Path=/` cookie（加密后存放，密钥在 Netlify 环境变量）
4. 后续每个 `/api/github/*` 请求由 Function 读取 cookie、解密、调 GitHub API
5. token 8 小时过期；Function 检测到 401 时用 refresh token 静默续期并重设 cookie

**环境变量**（Netlify）：

```
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_TOKEN_SECRET      # cookie 加密密钥
GITHUB_REPO              # XieYu-Zk/zerokami
```

### 3.3 为什么限定域名

- `file://` 无法接收 OAuth 回调，也无法带 cookie。
- `xieyuqaq.github.io` 与 `zerokami.cn` 跨站，`SameSite=Lax` cookie 不会发送。
- 因此 GitHub 模式只在 `zerokami.cn` 下启用；从 `file://` 或 GitHub Pages 打开时，启动弹窗只显示「本地目录」，并注明原因。

### 3.4 安全要点

- token 不进 localStorage、不进前端内存、不出现在 URL。
- Function 只代理白名单端点（见 §11），不接受任意路径，避免变成开放代理。
- 所有写操作校验仓库名为 `XieYu-Zk/zerokami`，防止误配。

---

## 4. 仓库与分支模型

| 项 | 规则 |
|---|---|
| 仓库 | 私有，`XieYu-Zk/zerokami` |
| `main` | 已发布内容，编辑器内只读 |
| 草稿分支 | `draft/<abbrlink>`，一篇一分支 |
| 分支创建时机 | 第一次点「保存」时创建，避免空分支 |
| 分支基准 | 创建时的 `main` HEAD |
| 发布 | 差量 tree 合并到 `main`，一次 commit |
| 发布后 | 删除对应 `draft/*` 分支 |
| 丢弃草稿 | 删除分支，文章回到 `main` 版本 |
| 删除文章 | 在草稿分支内删除文件，发布时生效 |

**仓库内容边界**（沿用现有 `.gitignore`）：

- 入库：`source/`、`themes/`、`_config.yml`、`package.json`、`package-lock.json`、`netlify.toml`、`netlify/functions/`
- 不入库：`public/`、`db.json`、`.deploy_git/`、`node_modules/`、`tools/`（编辑器独立仓库）、`.workbuddy/`

---

## 5. abbrlink 规则

### 5.1 生成

```
abbrlink = crc32(title) 的十六进制，不补零
冲突时 +1 递增，直到不与项目中任何已有 abbrlink 重复
```

与 `hexo-abbrlink`（`alg: crc32`、`rep: hex`）一致。编辑器写入后，Hexo 端「有值就不改」，两边不会打架。

### 5.2 时机与行为

| 场景 | 行为 |
|---|---|
| 新建文章（已填标题） | 立即生成并写入 |
| 新建时标题为空 | 留空；输入标题后补 |
| 修改标题 | **不重算**，保 URL 稳定 |
| 点击输入框内的刷新图标 | 按当前标题重算，弹确认框（会改 URL） |
| 打开已有文章（有值） | 原样显示，可编辑 |
| 打开已有文章（值为空） | 提示可生成，不自动改 |
| 复制文章 | 标题加「副本」，按新标题生成新值 |
| 另存为 / 改名保留旧文件 | 按新标题生成新值 |
| 手动填入重复值 | 保存时报错并指出与哪篇重复 |

### 5.3 UI 改动

- 移除 `#lock-abbrlink` 锁按钮。
- 输入框右侧内嵌刷新图标（内联 SVG，`position:absolute`），点击重算。
- 占位文案由「生成后自动填入」改为「按标题自动生成，可修改」。
- 底部按钮「预估 abbrlink」移除（功能并入刷新图标）。

---

## 6. 列表与状态机

### 6.1 列表聚合

数据源：

- `main` 的 `source/_posts`（已发布）
- 所有 `draft/*` 分支的 `source/_posts`（草稿）

聚合规则：按 `abbrlink` 归并；同一 abbrlink 在 main 与 draft 同时存在时只显示一条，标记「草稿」并视为草稿版本。

列表加载策略（性能关键）：

- 用 `GET /git/trees/{main}?recursive=1` 一次拿到所有路径，**不读文件内容**。
- 标题默认取文件名去掉 `.md` 与 `<yy> ` 前缀；打开文章后才用 front matter 标题覆盖。
- 每个草稿分支 1 次 trees 请求；结果按分支 HEAD sha 缓存 5 分钟。

### 6.2 状态机

| 模式 | 文章来源 | 可编辑 | 主按钮 | 次按钮 |
|---|---|---|---|---|
| 本地 | 目录 | 是 | 保存 | — |
| GitHub | `main` | 否 | **编辑** | — |
| GitHub | 草稿分支 | 是 | 保存 | 发布 |
| GitHub | 列表多选草稿 | — | — | 发布选中（N） |

- 点「编辑」：以该文章在 `main` 的当前版本为基准，进入可编辑态，按钮组变为「保存 / 发布」，此时**尚未创建分支**。
- 第一次保存才创建 `draft/<abbrlink>` 并提交第一版。
- 关闭未保存的编辑：无任何远端副作用，恢复只读态。

---

## 7. 读写流程

### 7.1 启动

1. 弹窗二选一：本地目录 / GitHub 仓库。
2. 本地 → 现有「连接目录」引导，流程不变。
3. GitHub → 检查登录态：未登录跳授权；已登录选仓库（默认上次）→ 加载列表。
4. 记住上次选择，但每次启动仍弹窗（可用「记住本次选择」跳过）。

### 7.2 打开已发布文章

- 读 `main` 上的文件内容。
- 属性区与正文只读，显示「已发布 · 只读」。
- 主按钮显示「编辑」。

### 7.3 保存（写草稿分支）

首次保存：

1. `POST /git/blobs` 写入正文与新增图片（如无图片可跳过）
2. `POST /git/trees`（`base_tree` = main tree）
3. `POST /git/commits`（parent = main HEAD）
4. `POST /git/refs` 创建 `refs/heads/draft/<abbrlink>`

后续保存：

1. 取分支当前 HEAD 的 tree
2. 构造新 tree（只含变更文件）
3. 创建 commit（parent = 分支 HEAD）
4. `PATCH /git/refs/heads/draft/<abbrlink>` 更新（不带 force）
5. 422/409 → 提示「草稿已更新，请刷新后重试」

### 7.4 发布（单篇或批量）

1. 读取 `main` HEAD 与 tree
2. 对每个选中草稿分支执行 `GET /compare/{mainHead}...{branch}`，取变更文件列表
3. 冲突检查：
   - 分支的 base commit ≠ 当前 `main` HEAD，且变更文件在 `main` 上也被改过 → 拒绝，提示「main 已更新，请重开草稿」
   - 两个选中草稿改同一文件 → 拒绝
4. 构造合并 tree：`base_tree` = main tree，entries = 各分支变更文件（新增/修改用 blob sha，删除用 `sha: null`）
5. `POST /git/commits`（parent = main HEAD）
6. `PATCH /git/refs/heads/main`（不带 force）
7. 删除已发布的草稿分支
8. 提示「已推送，Netlify 将开始构建」

**结果**：N 篇草稿 → 1 次 commit → 1 次部署。

### 7.5 删除文章

1. 在草稿分支内删除 `.md` 文件（tree entry `sha: null`）
2. 扫描图片引用，仅删除不再被任何文本引用的图片
3. 与文章删除同一次 commit、同一次发布

---

## 8. 图片管理

### 8.1 功能范围

列表、按需预览、上传、删除、一键清理孤儿图。不做重命名 / 移动。

**列表字段**：路径、大小、引用数、来源（main / 草稿 / 待删除）。

**上传**：路径 `source/images/YYYY/MM/<10位随机字母数字>.<后缀>`，与现有规则一致。

**预览**：默认不加载图片，只显示元信息；点击某张时才 `GET /contents/...`（`Accept: application/vnd.github.raw`）拉原图转 `objectURL`，并缓存到 IndexedDB。私有仓库没有服务端缩略图，这是唯一可行方式。

### 8.2 引用扫描

范围：仓库内全部文本文件，跳过 `node_modules/`、`public/`、`.git/`、`.deploy_git/`、`tools/`。

扩展名白名单：`.md` `.markdown` `.html` `.ejs` `.styl` `.css` `.yml` `.yaml` `.json`（排除 `package-lock.json`）`.js`

判定方式：**按文件名做纯文本搜索**，不解析 Markdown 语法。只要文件名出现在任何文本中即视为被引用，覆盖 `![]()`、`<img src>`、`style="background:url()"`、`cover:`、注释等所有写法。

扫描结果按「仓库版本 + 分支 HEAD」缓存，删除或发布时才重算。

### 8.3 删除单张图片

1. 扫描引用（main + 所有草稿分支）
2. 引用数 > 0：拒绝，列出引用它的文章（分支 + 路径）
3. 引用数 = 0：加入「待发布图片删除队列」

### 8.4 一键清理孤儿图

1. 全仓扫描
2. 列出引用数 = 0 的图片：路径、大小、合计可释放空间
3. 二次确认后执行
4. 生效方式二选一（**待定，见 §16**）：
   - A：全部加入待发布队列，随下次草稿发布生效
   - B：创建临时分支 `chore/clean-images-<ts>` 并立即合并，多一次部署

### 8.5 图片变更如何进入 main

| 来源 | 承载 | 发布方式 |
|---|---|---|
| 文章内插入图片 | 草稿分支（blob 已在该分支） | 随该草稿的差量 tree 一起提交 |
| 文章内删除图片引用 | 草稿分支 | 发布时列清单，确认后删除 |
| 图片管理页上传 | 当前打开的草稿分支 | 随该草稿发布 |
| 图片管理页删除 | 待发布队列 | 下次发布任意草稿时一并提交 |
| 一键清理 | 待发布队列或临时分支 | 见 §8.4 |

没有打开的草稿时，图片管理页的上传按钮禁用，提示「请先新建或打开一篇草稿」。

### 8.6 删除引用不自动删图

- 保存草稿：只记录，不动图片。
- 发布时：列出「本次发布后不再被引用的图片」，勾选确认后才从 tree 中删除。
- 目的：避免误删段落导致图片被静默清理。

---

## 9. 属性区与按钮

| 元素 | 本地模式 | GitHub·main | GitHub·草稿 |
|---|---|---|---|
| abbrlink 输入框 | 可编辑 + 刷新图标 | 只读 | 可编辑 + 刷新图标 |
| 日期 | 现有锁定规则 | 只读 | 现有规则 |
| 保存 | 写盘 | 隐藏 | 提交到草稿分支 |
| 发布 | 无 | 无 | 合并到 main |
| 编辑 | 无 | 建草稿上下文 | 无 |
| 删除 | 现有 | 隐藏 | 删除并走发布流程 |

---

## 10. 数据与缓存

| 数据 | 位置 | 失效 |
|---|---|---|
| 登录态 | httpOnly cookie | 8 小时 / 登出 |
| 草稿 base commit | localStorage（`branch → sha`） | 发布后删除；丢失时用 compare 兜底 |
| 列表 tree | localStorage | 分支 HEAD sha 变化 / 5 分钟 |
| 图片引用索引 | localStorage | 仓库版本 + 分支 HEAD 变化 |
| 图片预览 | IndexedDB（blob） | 手动清空 / 容量上限 |
| 待发布图片队列 | localStorage | 发布成功后清空 |

---

## 11. API 映射

| 操作 | 端点 |
|---|---|
| 仓库信息 | `GET /repos/{owner}/{repo}` |
| 分支列表 | `GET /repos/{owner}/{repo}/git/matching-refs/heads/draft/` |
| 目录树 | `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` |
| 读文件 | `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` |
| 创建 blob | `POST /repos/{owner}/{repo}/git/blobs` |
| 创建 tree | `POST /repos/{owner}/{repo}/git/trees` |
| 创建 commit | `POST /repos/{owner}/{repo}/git/commits` |
| 创建分支 | `POST /repos/{owner}/{repo}/git/refs` |
| 更新分支 | `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` |
| 删除分支 | `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` |
| 分支差异 | `GET /repos/{owner}/{repo}/compare/{base}...{head}` |

Function 白名单只放行以上路径模式，其余返回 404。

---

## 12. UI 改动清单

1. **启动弹窗**：两步向导，第一步选模式，第二步沿用现有目录引导或进入 GitHub 列表。
2. **列表**：一栏显示；草稿项在标题前加「草稿」文字标签；顶部增加「发布选中（N）」。
3. **属性区**：移除 abbrlink 锁按钮，输入框内加刷新图标；只读态整体置灰。
4. **按钮组**：按 §9 表格切换。
5. **图片管理**：新增页面（侧栏入口），列表 + 预览抽屉 + 上传 + 删除 + 一键清理。
6. **状态提示**：顶部显示当前仓库 / 分支；发布后显示「已推送，等待 Netlify 构建」。

---

## 13. 错误处理

| 场景 | 处理 |
|---|---|
| 401 token 过期 | Function 自动 refresh；失败则跳登录 |
| 403 权限不足 | 提示重新安装 GitHub App 并确认仓库授权 |
| 409 / 422 ref 冲突 | 提示「远端已更新」，刷新列表，不覆盖 |
| 发布时 main 已前进 | 拒绝发布，提示重开草稿 |
| 两个草稿改同一文件 | 拒绝批量发布，提示先合并内容 |
| 网络失败 | 内容留在本地草稿（localStorage），提示重试 |
| Function 超时 | 拆小请求重试；长任务显示进度 |

---

## 14. 性能与限制

| 项 | 现状 / 估算 |
|---|---|
| 文章数 | 91 篇，图片 223 张 / 40MB |
| 列表加载 | 1 + N 次 trees（N = 草稿分支数），缓存 5 分钟 |
| 打开文章 | 1 次 contents |
| 保存 | 2–4 次 API（blob/tree/commit/ref） |
| 批量发布 | 4 + N 次 API（N = 选中草稿数），一次 commit |
| 引用扫描 | 约 130 个文本文件，缓存后仅在删除/发布时重算 |
| Netlify Function | 免费版 10s 超时；单次发布在 2s 内完成 |
| GitHub 限额 | App 安装 token 5000 次/小时，单用户远低于上限 |
| Netlify 部署 | 每次发布 1 次构建，按每月 5–6 篇计算约 1/3 额度 |

---

## 15. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | abbrlink 改造（core / app / index / 测试 / README） | 现有 9 套测试全绿，本地模式行为不变 |
| 2 | 启动选择器 + GitHub App 认证 + 只读列表 | 能在编辑器里列出 main 的 91 篇 |
| 3 | 草稿分支读写 + 按钮状态机 | 新建草稿 → 保存 → GitHub 上出现 `draft/*` 分支 |
| 4 | 单篇发布 + 批量发布 | N 篇草稿一次发布，Netlify 只构建一次 |
| 5 | 图片管理（列表 / 预览 / 上传 / 删除） | 上传的图落在 `source/images/YYYY/MM/`，删除受引用检查约束 |
| 6 | 删除文章 + 孤儿图清理 + 一键清理 | 删文章只清理无引用图片 |
| 7 | 文档（README、使用说明） | — |

阶段 1 与后续完全解耦，可先独立完成。

---

## 16. 待确认

1. **一键清理的生效方式**：A（进队列，随下次发布）还是 B（临时分支立即合并，多一次部署）？两者可以都做，A 为默认、B 为弹窗里的显式选项。
2. **批量发布上限**：建议一次最多 20 篇，超过时提示分批，避免单次请求过多。
3. **图片预览**：接受「点击才加载原图」而不是真正的缩略图？
4. **草稿丢弃**：关闭未保存的编辑不产生分支；已保存的草稿需要显式「丢弃草稿」才删除分支。这样处理可以吗？
5. **README 中的插图**：`README.md` 引用了 `zerokami.cn/images/...` 的站内图，图片管理扫描时会把它们算作引用，属于正常行为，确认不需要排除。

---

## 17. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| `hexo-lazy-image` 的 `no-lazy` 是本地 node_modules 补丁 | 源码上云后 Netlify `npm ci` 会还原官方版，logo 被改写成懒加载 | 用 patch-package 或 fork 固化（阶段 2 前置） |
| `netlify.toml` 目前在 `source/` 下 | 源码构建时 Netlify 读不到配置 | 移到仓库根，`publish = "public"` |
| `netlify/functions` 在 `source/` 下 | Netlify 不允许 functions 在 publish 内 | 移到仓库根 |
| `tools/hexo-editor` 是嵌套 git 仓库 | 外层提交会变成 gitlink，文件不进去 | 加入 `.gitignore` 或做 submodule |
| 私有仓库 API 依赖 App 授权 | 授权失效后全部操作失败 | 401 时引导重新授权 |
| 图片 40MB 随仓库增长 | clone 变慢、预览变慢 | 按需加载；后续可考虑图床或 LFS |

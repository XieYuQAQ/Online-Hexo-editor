# Hexo 在线文章编辑器

在浏览器里直接读写 Hexo 博客仓库的 `source/_posts` 与 `source/images`：草稿存成 Git 分支，发布时合并到 `main`，由 Netlify 自动构建上线。

|  |  |
|---|---|
| 形态 | 纯静态页面：`index.html` + 3 个 JS + 1 份 CSS，无构建步骤、无运行时依赖 |
| 数据 | GitHub 仓库（Git Data API）；浏览器拿不到任何 token |
| 认证 | GitHub App 的 user-to-server 授权，token 加密后写进 httpOnly cookie |
| 发布 | 差量 tree → 1 个 commit → 1 次 Netlify 构建 |

> 本项目由 DeepSeek V4.1 Flash 生成，按一套既有的 Hexo 站点约定编写。换到结构不同的博客上，图片路径、视频块、短链规则都要跟着改——先把下一节看完再决定要不要用。

---

## 目录

- [它假设了什么](#它假设了什么)
- [功能一览](#功能一览)
- [工作方式](#工作方式)
- [分支模型与发布](#分支模型与发布)
- [文章编辑](#文章编辑)
- [图片管理](#图片管理)
- [安全模型](#安全模型)
- [项目结构](#项目结构)
- [测试](#测试)
- [部署](#部署)
- [日常升级与回滚](#日常升级与回滚)
- [已知边界](#已知边界)

---

## 它假设了什么

这些是硬约定，不符合就得改代码：

| 约定 | 具体要求 |
|---|---|
| 文章目录 | `source/_posts/*.md`，front matter 位于文件开头 |
| 图片目录 | `source/images/**`；正文与 `cover` 以 `/images/...` 引用，编辑器只往这里写图 |
| 短链 | `hexo-abbrlink`，`alg: crc32` + `rep: hex`，永久链接形如 `:abbrlink.html` |
| front matter | 只解析 `title`、`abbrlink`、`description`、`tags`、`date`、`cover`；其余字段原样保留、按原顺序回写 |
| 视频块 | 文章里是「iframe + `checkGoogle()` 判断网络」的原始 HTML 块，不是 Hexo 标签插件 |
| 仓库 | 单一仓库、单一 `main` 分支；站点由 Netlify 监听 `main` 自动构建 |
| 运行环境 | 必须与 `/api/github/*` 代理、`/.netlify/functions/github-auth-*` 授权函数**同源**部署 |

最后一条是硬性的：cookie 只在同站请求里发送，单独把前端丢到 GitHub Pages 上打开是连不上的（原因见[部署](#部署)）。

---

## 功能一览

**列表与检索**

- `main` 用一次 `trees` 请求拿到全部文章路径，每个草稿分支各一次；标题 / 日期 / 标签按需读 blob，结果缓存在浏览器
- 搜索标题、文件名、标签；按日期或文件名排序；标签筛选；只看有未保存改动的
- 草稿条目带黄色「草稿」标记；底部实时显示草稿数与「发布选中 (N)」
- 左下角 GitHub 状态：仓库名、默认分支、是否可写

**编辑**

- 属性区六个字段：标题、链接（abbrlink）、描述、标签、时间、封面
- abbrlink 按 `crc32(标题)` 生成，冲突自动递增；带一个「按标题重算」按钮（会提示改 URL 的风险）
- 封面可从本地选图并上传到草稿、可清空、也可把图片直接拖到预览框
- 正文所见即所得，支持标题、加粗、斜体、删除线、行内代码、颜色、有序 / 无序 / 任务列表、引用、表格、代码块、分割线、`<!--more-->`、`<kbd>`、上下标、折叠块、居中容器、脚注、链接、图片、视频块
- 视频块在光标离开时折叠成 iframe 预览，光标进入时展开源码
- 粘贴按纯文本处理，不会把网页样式带进正文
- 状态栏实时显示字符数、行数、字数、预计阅读时间与光标行列
- 明 / 暗 / 跟随系统三档主题，首屏前先上色，避免闪白闪黑
- 窄屏下侧栏收到顶部并可折叠，属性区在「属性 / 正文」两个面板之间切换

**草稿与发布**

- 文章改动先存进 `draft/<abbrlink>` 分支，`main` 在编辑器内只读
- 单篇发布；勾选多篇后一次批量发布（上限 20 篇），N 篇只产生 1 次构建
- 删除已发布文章走「标待删除 → 发布」，发布前可撤销
- 从未发布过的草稿直接删分支，不产生部署

**图片**

- 列表、按需预览、上传、引用检查删除、一键清理孤儿图
- 发布时把「因这次改动失去最后一个引用」的图片列出来，逐张勾选是否一并删除

**容错**

- 未保存内容进 localStorage，刷新 / 重开时提示恢复
- 登录过期弹独立提示层，先把草稿落盘再引导重新登录
- 授权失败停在引导页显示原因，不会 401 → 授权 → 失败 → 401 死循环

---

## 工作方式

```
浏览器（编辑器页面）
  │  同域 fetch，自动带 httpOnly cookie
  ▼
你的域名 /api/github/*
  │  Netlify Function：校验登录态、注入 token、限定仓库与端点
  ▼
api.github.com
  │
  ├─ main              已发布，只读
  └─ draft/<abbrlink>  草稿，一篇一支

发布：差量 tree → 1 个 commit → PATCH main → Netlify 构建 → 站点更新
```

前端本身只是一堆静态文件；真正让它能写仓库的是三件事：**同源代理**、**GitHub App 授权**、**cookie 封装**。

---

## 分支模型与发布

| 位置 | 作用 |
|---|---|
| `main` | 已发布内容，编辑器内只读 |
| `draft/<abbrlink>` | 草稿，一篇一分支；第一次保存才创建 |

发布不是 `git merge`，而是用 GitHub 的 Git Data API 拼一个**差量 tree**：

1. 以当前 `main` 的 tree 为底；
2. 用 `GET /compare/{main}...{branch}` 取出该草稿改了哪些文件，只把这些 entry 叠上去（删除用 `sha: null`）；
3. 生成一个 commit，`parent` 指向 `main` 当前 HEAD；
4. `PATCH` 更新 `main` 引用（`force: false`），再删掉已合并的草稿分支。

这样做的好处：

- 草稿即使落后于 `main`，也只覆盖自己改过的文件，不会把别人的文章回退；
- 引用更新不带 force，遇到并发写入直接失败，不会出现「只发了一半」；
- 发布失败时 `main` 不动，草稿分支和本地草稿都还在。

**冲突处理**：若草稿的 base commit 已不是当前 `main`，且两者改到了同一个文件，发布被拒绝并提示「请重新打开该草稿」；两篇草稿改同一文件时，批量发布也会被拒绝。项目不做自动合并。

**批量发布**：列表勾选多篇 → 底部「发布选中 (N)」。一次最多 20 篇，超过会要求分批。

**删除**：

- 已发布文章 → 在草稿分支里把该文件删掉（tree entry 设为 `null`）、标记「待删除」，发布后才从 `main` 消失，发布前可以「撤销删除」；
- 从未发布过的草稿 → 直接删分支，不产生部署。

---

## 文章编辑

属性区与 front matter 一一对应：

| 字段 | 说明 |
|---|---|
| `title` | 必填。为空不能保存 |
| `abbrlink` | 短链。按 `crc32(标题)` 的十六进制生成，与 `hexo-abbrlink` 的 `crc32 + hex` 一致；自动分配时与已有值冲突会 +1 递增 |
| `description` | 摘要，出现在社交卡片与搜索结果；多行会写成 `>-` 折叠块 |
| `tags` | 流式数组 `tags: [a, b]`；输入框回车或逗号分隔 |
| `date` | `YYYY-MM-DD HH:mm:ss`；新建文章保存前锁定，避免误改 |
| `cover` | 站内绝对路径或完整 URL，可上传、可选图、可拖入 |

abbrlink 的行为约定：

- 新建文章时按标题立即分配；
- **改标题不重算**，保证已有 URL 不失效；
- 想改只能点输入框右侧的重算按钮，会弹窗确认并提示这会改变文章地址；
- 手填的值原样保存，编辑器不校验是否与其他文章重复——填成一样就是两个页面抢同一个 URL，自己留意。

正文是所见即所得，编辑的是真实的 Markdown 文本，渲染只是叠在上面的视图，所以不会产生「富文本转换后格式跑掉」的问题。工具栏、快捷键、撤销栈都是自己实现的，不依赖浏览器 `execCommand`。

**快捷键**

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + S` | 保存到草稿分支 |
| `Ctrl/Cmd + Shift + N` | 新建文章 |
| `Ctrl/Cmd + B` / `I` / `K` | 加粗 / 斜体 / 链接 |
| `Ctrl/Cmd + 2` / `3` / `4` | 二 / 三 / 四级标题 |

未保存的改动会写进 localStorage；下次打开同一篇时提示「恢复草稿 / 用远端版本」。关页面时若有未保存内容，浏览器会拦一次。

---

## 图片管理

侧栏「图片」入口：

- **列表**：路径、大小、引用数、「草稿」来源标记、是否在待删除队列
- **预览**：点缩略图才去拉原图。私有仓库没有服务端缩略图，这是唯一可行方式
- **上传**：必须先打开一篇已保存的草稿；文件写入 `source/images/YYYY/MM/<10 位随机字母数字>.<后缀>`，成功后自动在光标处插入 `![](/images/...)`
- **类型校验**：只接受 png / jpg / gif / webp / bmp / ico / avif，且会读文件头核对真实类型。后缀对但内容不符的直接跳过并提示；SVG 不支持（代理层不可写）
- **删除**：仍被任何文本引用的图拒绝删除，并列出引用位置；零引用的图进入「待删除」队列，随下一次发布一起提交
- **一键清理孤儿图**：把所有零引用图加入队列，二次确认后生效
- **发布时确认**：因为这次改动丢掉最后一个引用的图片，会在发布前弹窗逐张勾选

引用扫描的做法是**按文件名做纯文本搜索**，不解析 Markdown 语法。因此 `![]()`、`<img src>`、`style="url()"`、`cover:`、注释里的引用都算数。扫描范围是仓库内全部文本文件，跳过 `node_modules`、`public`、`tools`、`.deploy_git`、`.git` 与 `package-lock.json`。结果按「main sha + 各草稿分支 sha」缓存，仓库版本变了才重扫。

---

## 安全模型

配套代理层（`/api/github/*` 与 `github-auth-*`）按下面的规则实现，前端只是它的客户端：

- 前端所有请求走同域 `/api/github/*`，不直连 `api.github.com`，也不接触 token
- `gh_token` 存 httpOnly cookie：`Path=/api/github`、`Secure`、`SameSite=Lax`，值为 AES-256-GCM 加密后的 `iv + tag + ciphertext`（base64url），密钥来自环境变量
- `Path=/api/github` 意味着访问博客页面、图片、评论接口时都不会捎带 token
- `gh_oauth_state` 是例外，必须保持 `Path=/`：回调挂在 `/.netlify/functions/github-auth-callback`，收窄路径会 100% `state_mismatch`
- state 校验用 sha256 归一化后 `crypto.timingSafeEqual`，长度不等也不抛错
- 仓库校验是「小写全等 或 `PREFIX + '/'` 前缀」，只写 `startsWith(PREFIX)` 会放行 `xxx-backup` 这类同前缀仓库
- 端点白名单按**方法 + 路径**双重校验：`GET` 限仓库信息、ref、tree、blob、commit、`source/_posts|images` 下的 contents、compare；`POST` 限 blob / tree / commit / refs；`PATCH` 只允许 `main` 与 `draft/*`；`DELETE` 只能删 `draft/*`；`PUT` 一律不接受
- 写 `tree` 时路径必须落在 `source/_posts/` 或 `source/images/` 下，后缀与文件头都要对；`POST /git/refs` 的 `body.ref` 只能是 `refs/heads/draft/*`
- `PATCH` ref 要求新 commit 的父提交等于分支当前 head，`force` 只接受 `false`；冲突返回 `409`，编辑器据此提示重开草稿
- token 过期由函数用 refresh token 静默续期；续期失败返回 `401` 但**不清 Cookie**（并发续期时清 Cookie 会覆盖刚写入的新值），由前端弹「登录已过期」
- 授权失败会 302 回 `?auth=error&reason=…`，前端停在引导页显示原因，不会自动再跳授权页
- 代理响应统一带 `X-Content-Type-Options: nosniff`；编辑器页面额外带 `X-Frame-Options` 与 `Referrer-Policy`

---

## 项目结构

```text
hexo-editor/
├── index.html                   界面入口（唯一页面）
├── assets/
│   ├── core.js                  格式层：front matter 解析/序列化、abbrlink、文件名、视频块、图片魔数（浏览器/Node 通用）
│   ├── github.js                存储层：认证入口、仓库/分支/提交/发布、blob 读写
│   ├── app.js                   主程序：列表、编辑器、草稿、发布、图片管理、快捷键
│   └── editor.css               全部样式
├── test/
│   ├── run.mjs                  串行跑全部套件
│   ├── helpers.mjs              语料定位、选文、等待启动
│   ├── fixtures/posts/          4 篇内置样例
│   └── *.test.mjs               10 套测试
├── docs/
│   └── github-mode-plan.md      最初的设计稿（部分内容已被实现取代）
├── package.json                 仅测试需要；浏览器使用无需安装依赖
├── package-lock.json
└── README.md
```

三个脚本用最朴素的 `<script>` 顺序加载，共享 `window.HexoCore` / `window.GitHubStore`；`core.js` 是 UMD，Node 里可以直接 `require` 做单测。

**注意**：本仓库只有前端。`/api/github/*` 代理与 `github-auth-*` 授权函数不在这个仓库里，需要按[部署](#部署)一节的说明放到承载站点的 Netlify 项目中。

---

## 测试

只需要 Node.js 18+：

```bash
npm ci                 # 只装测试依赖（jsdom / js-yaml / hexo-abbrlink）
npm test               # 自动找语料：相邻博客仓库的 source/_posts，找不到就用内置样例
npm run test:fixtures  # 强制用 test/fixtures/posts 的 4 篇样例
```

10 套、约 490 条断言（数量随语料篇数变化，以命令行输出为准）：

| 套件 | 内容 |
|---|---|
| `roundtrip` | 每篇 `.md` 读入 → 序列化，逐字节比对（BOM / CRLF / 未知字段都不能变） |
| `edit` | 只改一个字段时，输出与原文的差异必须只落在该字段上 |
| `selectors` | `app.js` 用到的 `#id` / `data-act` / class 钩子在 `index.html` 里真实存在 |
| `ui` | jsdom 真实加载页面，验证列表、编辑器、属性区的结构 |
| `interact` | 在界面上真的操作：改标题、改标签、插入 Markdown、保存、删除 |
| `wysiwyg` | 正文 DOM 往返逐字节不变、块级识别、回车 / 退格 / 撤销 |
| `github` | 内存 Git + mock fetch：列表、保存、单篇与批量发布、删除与撤销、新建、图片引用扫描、待删除队列、孤儿图确认、409 重试 |
| `auth` | `?auth=error` 不自动跳授权、会话中途 401 的提示与草稿落盘 |
| `images` | 7 种位图的魔数识别，必须与代理层的白名单逐条对齐 |
| `upload` | 真实加载页面跑上传链路：合法 PNG 通过，`.ejs` / `.pdf` 被前端拦下 |

补充说明：

- 语料目录可用 `HEXO_EDITOR_POSTS_DIR` 指定，默认按「相邻博客仓库 → 内置样例」的顺序查找；单套可 `node test/xxx.test.mjs` 直接跑
- 全部测试不发真实网络请求、不执行构建、不推送任何东西
- `github` 套件里的 `[草稿保存] Error: 远端文章已变更…` 是**故意制造冲突**的用例输出，不代表失败，看最后的 `Suites: 10, failed: 0`

---

## 部署

### 0. 先理解三块拼图

| 组成 | 放在哪 | 作用 |
|---|---|---|
| 编辑器前端 | 任意静态托管（本文以 GitHub Pages 为例） | 页面本身 |
| 子路径代理 | 承载站点的 Netlify 项目 | 把 `/tools/online-hexo-editor/*` 转发到前端，让它落在你的域名下 |
| 授权 + API 代理 | 同一个 Netlify 项目 | `/api/github/*`：校验登录态、注入 token、限仓库限端点 |

为什么前端不能直接用自己的域名打开：登录态在 `SameSite=Lax` 的 cookie 里，而且 `Path=/api/github`。前端若跑在 `*.github.io`，请求打到自己的域时既没有 `/api/github` 这个端点，也带不上主站 cookie，必定 401。所以正确姿势是**用同域子路径代理把页面「搬」到主站名下**。

（也可以把前端静态文件直接放进站点的 `publish` 目录，这样就省掉子路径代理这一块，授权与 API 代理仍然需要；代价是改编辑器要重新构建整个站点。）

```
https://你的域名/tools/online-hexo-editor/
  ├── /api/github/*                    → Netlify Function（github-api）
  └── /.netlify/functions/github-auth-* → Netlify Function（授权）
```

### 1. 前置条件

- [ ] 一个 Hexo 博客仓库，`source/_posts` 与 `source/images` 都在里面；私有仓库也可以
- [ ] 该仓库已接入 Netlify，`main` 推送能自动构建
- [ ] 一个能绑定域名的 Netlify 站点（HTTPS 必须，`Secure` cookie 依赖它）
- [ ] 仓库 Settings → Pages 可用（用于托管前端）
- [ ] 本地有 Node.js 18+（跑测试；Netlify 构建也用它）

### 2. 把前端发到 GitHub Pages

1. Fork 本仓库到你的账号（也可以直接新建仓库再把文件推上去）。
2. Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。
3. 记下 Pages 地址，形如 `https://你的用户名.github.io/你的仓库名`，后面配 `ONLINE_HEXO_EDITOR_UPSTREAM` 要用。

编辑器默认指向一个写死的仓库名。两种改法，任选其一：

```html
<!-- index.html：必须放在 assets/github.js 之前 -->
<script>window.HEXO_EDITOR_REPO = '你的用户名/你的博客仓库';</script>
```

```js
// assets/github.js 第 9 行
var REPO = root.HEXO_EDITOR_REPO || '你的用户名/你的博客仓库';
```

这个值必须和服务端的 `GITHUB_REPO` 完全一致（服务端不区分大小写），否则所有请求都会 403。

### 3. 创建 GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**：

| 项 | 填什么 |
|---|---|
| GitHub App name | 任意，例如 `hexo-editor-你的名字` |
| Homepage URL | 你的站点地址 |
| **User authorization callback URL** | `https://你的域名/.netlify/functions/github-auth-callback` |
| Webhook | 取消勾选 Active（本项目不用 webhook） |
| Repository permissions → **Contents** | **Read and write** |
| Repository permissions → Metadata | Read（必选基线，自动带上） |
| 其他权限 | 全部 No access |
| Where can this app be installed | 仅自己的账号即可 |

创建后：

1. 记下 **Client ID**；
2. 点 **Generate a new client secret**，立刻复制 **Client secret**（只显示一次）；
3. 左侧 **Install App** → 选择账号 → 选择 **Only select repositories** → 勾选你的博客仓库 → Install。

> 走的是 GitHub App 的 user-to-server 授权流：回调拿到 `access_token`（8 小时）与 `refresh_token`，所以能静默续期。使用者还必须对目标仓库有 push 权限，否则能登录但写不进去。

### 4. 放置 Netlify Functions

> 这些函数文件**不在本仓库里**。本仓库只负责前端静态文件；授权与代理函数随博客站点一起部署，Fork 本仓库不会自动得到它们——需要按下面的职责说明自行实现，或从已有的部署里复制过去。

函数源码**不能放在 `publish` 目录里**（`public/` 下的东西会被当静态资源发布，`netlify/functions` 又必须可被 Netlify 打包）。推荐放在博客仓库根：

```text
你的博客仓库/
├── netlify/
│   └── functions/
│       ├── github-auth-start.js        跳转 GitHub 授权页，下发 state
│       ├── github-auth-callback.js     校验 state、换 token、加密写 cookie
│       ├── github-api.js               API 代理：鉴权、限仓库、限端点、续期
│       ├── lib/
│       │   └── github-writes.js        写操作策略（路径、后缀、文件头、ref 前进规则）
│       └── online-hexo-editor-proxy.js 子路径反向代理（注入 <base>）
├── source/
├── netlify.toml
└── package.json
```

各函数职责与实现要点：

| 文件 | 职责 | 关键点 |
|---|---|---|
| `github-auth-start.js` | 拼 `https://github.com/login/oauth/authorize`，302 过去 | 随机 state 写 cookie：`Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` |
| `github-auth-callback.js` | 校验 state → `POST /login/oauth/access_token` 换 token → 加密写 `gh_token` | `gh_token` 用 `Path=/api/github`；失败 302 到 `?auth=error&reason=…` 并清 state |
| `github-api.js` | 读 cookie、解密、注入 `Authorization`、转发到 `api.github.com` | 仓库全等校验；方法 + 路径白名单；401 时用 refresh token 续期，续期失败不清 Cookie |
| `lib/github-writes.js` | 判断一次写操作是否允许 | 必须 JSON、不带 query、tree 路径限 `source/_posts/` 与 `source/images/`、后缀 + 魔数校验、ref 只能前进、`force` 必须 `false`、冲突 409 |
| `online-hexo-editor-proxy.js` | 把挂载点转到前端静态站点 | HTML 注入 `<base href="/tools/online-hexo-editor/">`；HTML/JS/CSS 不缓存 |

函数用 CommonJS 的 `exports.handler`，依赖 Node 18+ 自带的 `fetch` 与 `crypto`，不需要 `node-fetch`。若你把编辑器挂到别的前缀，`online-hexo-editor-proxy.js` 里的 `MOUNT` 常量、`netlify.toml` 的 redirect、`GITHUB_AUTH_RETURN` 三处要一起改。

两个 Netlify 的坑：

- 一次要下发多条 `Set-Cookie` 时（`gh_token` 新值 + 清旧值 + 清 state），必须用 `multiValueHeaders`；普通 `headers` 只接受字符串，写数组会被吞掉；
- `functions` 目录写对后，部署日志里会列出被打包的函数（`github-api`、`github-auth-start` 等）；一个都没列出来就是路径错了。

### 5. 配置 netlify.toml

```toml
[build]
  command = "npm ci && npx hexo generate"
  publish = "public"
  functions = "netlify/functions"

[build.environment]
  NODE_VERSION = "22"

# 1) 编辑器子路径：带尾斜杠与不带尾斜杠各一条
[[redirects]]
  from = "/tools/online-hexo-editor/*"
  to = "/.netlify/functions/online-hexo-editor-proxy"
  status = 200

[[redirects]]
  from = "/tools/online-hexo-editor"
  to = "/.netlify/functions/online-hexo-editor-proxy"
  status = 200

# 2) 授权入口：必须排在 /api/github/* 通配之前
[[redirects]]
  from = "/api/github/auth/start"
  to = "/.netlify/functions/github-auth-start"
  status = 200

# 3) API 代理
[[redirects]]
  from = "/api/github/*"
  to = "/.netlify/functions/github-api"
  status = 200
```

要点：

- `status = 200` 是 rewrite，地址栏不变，cookie 才会继续属于你的域；
- redirects 自上而下匹配，`/api/github/auth/start` 写在通配后面会被吞掉，表现为点登录直接 401；
- `functions` 目录必须在 `publish` 之外，否则 Netlify 会拒绝或把函数源码一起发布。

### 6. 配置环境变量

Netlify → Site configuration → Environment variables：

| 变量 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `GITHUB_APP_CLIENT_ID` | 是 | GitHub App 的 Client ID | `Iv1.0a1b2c3d4e5f6g7h` |
| `GITHUB_APP_CLIENT_SECRET` | 是 | 上一步生成的 Client secret | `a1b2c3…` |
| `GITHUB_TOKEN_SECRET` | 是 | cookie 加密密钥，**≥32 字节随机串** | 见下方命令 |
| `GITHUB_REPO` | 是 | 唯一放行的仓库，`owner/repo` | `your-name/your-blog` |
| `GITHUB_AUTH_CALLBACK` | 是 | 必须与 GitHub App 里登记的**一字不差**；默认值指向原作者域名，不改会失败 | `https://你的域名/.netlify/functions/github-auth-callback` |
| `GITHUB_AUTH_RETURN` | 建议 | 授权完成后回跳的地址 | `/tools/online-hexo-editor/?auth=ok` |
| `ONLINE_HEXO_EDITOR_UPSTREAM` | 用子路径代理时必填 | 前端静态站点地址，末尾不要带 `/` | `https://你的用户名.github.io/你的仓库名` |

生成密钥：

```bash
openssl rand -base64 32
# 没有 openssl 时（Windows 也行）：
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

注意：

- 函数代码里带有与原作者站点相关的默认值（回调地址、回跳地址、上游地址）。`GITHUB_AUTH_CALLBACK` 与 `ONLINE_HEXO_EDITOR_UPSTREAM` 必须显式覆盖，否则会指向别人的域名。
- 改过环境变量必须重新部署才生效（Deploys → Trigger deploy → Deploy site）。
- `GITHUB_TOKEN_SECRET` 换掉等于让所有已登录会话失效，这是正常的强制下线手段。

### 7. 部署并逐项验收

推送博客仓库触发构建，部署日志里应能看到 `github-api`、`github-auth-start` 等函数被打包。然后按顺序验：

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打开 `https://你的域名/tools/online-hexo-editor/` | 页面正常，样式与脚本都加载（无 404） |
| 2 | 未登录时自动跳转 | 地址栏出现 `github.com/login/oauth/authorize?client_id=…&redirect_uri=…&state=…` |
| 3 | 授权后回跳 | 回到 `/tools/online-hexo-editor/?auth=ok`，列表出现文章 |
| 4 | 左下角状态 | 显示仓库名与文章篇数，可写 |
| 5 | 打开任意文章 | 顶部显示「只读 · main」，正文可见 |
| 6 | 点「编辑」→ 改标题 → `Ctrl+S` | GitHub 上出现 `draft/<abbrlink>` 分支，含 1 个 commit |
| 7 | 点「发布」→ 确认 | `main` 多一个 `post: 标题` 的 commit；Netlify 开始构建；草稿分支被删 |
| 8 | 图片 → 上传一张 PNG | 落到 `source/images/YYYY/MM/`，正文插入 `![](/images/…)` |
| 9 | 图片 → 删除一张被引用的图 | 被拒绝，并列出引用它的文章 |

不想开浏览器时，可以用 curl 验代理层的三个边界：

```bash
# 未登录：应 401（不是 500，也不是 GitHub 的错误页）
curl -i https://你的域名/api/github/repos/你的用户名/你的博客仓库

# 别的仓库：应 403
curl -i https://你的域名/api/github/repos/octocat/hello-world

# 未授权的方法：应 405
curl -i -X PUT https://你的域名/api/github/repos/你的用户名/你的博客仓库/contents/x
```

### 8. 常见故障

| 症状 | 多半是 | 怎么查 |
|---|---|---|
| 页面 404 或样式全丢 | 子路径代理没生效；或 `index.html` 用了绝对路径 `/assets/...` | 看代理有没有注入 `<base>`；资源引用必须写成 `assets/...` |
| 点登录后一直 401 循环 | 回调失败 | 看地址栏 `?auth=error&reason=`，对照下面的「授权错误码」表 |
| 授权回来 `state_mismatch` | `gh_oauth_state` 的 `Path` 不是 `/`，或回调 URL 与 App 登记不一致 | 回调函数在 `/.netlify/functions/` 下，读不到 `Path=/api/github` 的 cookie |
| `403 repository not allowed` | 前端 `REPO` 与 `GITHUB_REPO` 不一致，或 App 没装到该仓库 | 两处字符串逐字对比 |
| 读仓库 404 | App 已创建但没 Install；或仓库名写错 | Settings → Applications 里看安装范围 |
| 保存报 409 / 「远端已更新」 | `main` 前进了，或同名文件被占用 | 重新打开该草稿再改；必要时删掉草稿分支重来 |
| 发布后界面还是旧的 | 代理层给 HTML/JS 加了长缓存 | HTML 用 `max-age=0, must-revalidate`，JS/CSS 用 `no-cache, must-revalidate` |
| 上传图片 403 | 类型不在白名单，或文件头与后缀不符 | 只支持 png/jpg/gif/webp/bmp/ico/avif；SVG 不支持 |
| 函数超时 / 502 | 单次请求太多，或上游慢 | 免费版函数 10 秒上限；拆分操作、减少单次批量篇数 |
| 环境变量改了没反应 | 没重新部署 | Deploys → Trigger deploy |

**授权错误码**

| `reason` | 含义 |
|---|---|
| `app_not_configured` | 没配 `GITHUB_APP_CLIENT_ID` / `SECRET` |
| `token_secret_missing` | 没配 `GITHUB_TOKEN_SECRET` |
| `no_code` | GitHub 没回传 code（多半是用户取消授权） |
| `state_mismatch` | state 对不上：cookie 路径错、回调 URL 不一致、或授权页停留超过 10 分钟 |
| `exchange_failed` | 调 GitHub 换 token 网络失败 |
| `no_token` | GitHub 明确拒绝（client secret 错、code 已用过、回调地址不匹配） |

---

## 日常升级与回滚

**升级前端**：改完 push 到 Pages 仓库即可。代理层对 HTML/JS/CSS 都是回源校验，浏览器不会长期吃旧文件。

**升级函数**：push 博客仓库 → Netlify 生产构建。注意这会**连带重建整个站点**，如果站点有其他改动没准备好，建议先用 Deploy Preview 验。

**回滚**：

- 函数 / 站点：Netlify → Deploys → 找到上一个成功的部署 → **Publish deploy**；
- 前端：`git revert` 后 push，等 Pages 发布；
- 数据：发布是普通 commit，`git revert` 那个 `post: …` 提交并推送即可让文章回到上一版（记得同步删掉残留的 `draft/*` 分支）。

---

## 已知边界

- **必须同源部署**：`file://` 收不到 OAuth 回调；直接开 GitHub Pages 带不上主站 cookie。两种情况都进不了编辑器。
- **只服务一个仓库**：代理按 `GITHUB_REPO` 精确放行，换仓库要改环境变量并重新部署。
- **私有仓库没有缩略图**：图片首次预览要从 GitHub 拉原图，之后按 sha 缓存。
- **不做图片重命名 / 移动**，也不做发布冲突的自动合并（冲突直接拒绝）。
- **批量发布上限 20 篇**，这是为了避免单次请求过多。
- **首次打开图片管理要全量扫一遍引用**：必须读一遍文本才知道谁引用了谁，之后走缓存与增量。
- **不支持 SVG 上传**：代理层的可写白名单里没有它。
- **不带 Hexo 运行环境**：编辑器不改主题、不预览站点、不执行 `hexo generate`，构建永远交给 Netlify。
- **单用户工具**：没有多人协作与实时同步，两个人同时改同一篇会以 409 收场。

---

## 相关文档

- `docs/github-mode-plan.md`：最初的设计稿，含更细的状态机与 API 映射；其中「本地目录模式」「`Path=/` cookie」等描述已被实现取代，冲突处以本文件为准。

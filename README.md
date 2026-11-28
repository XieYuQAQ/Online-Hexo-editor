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

页面、登录回调和 API 使用同一入口域名。可以由博客主站提供入口，也可以由带有 Functions 的独立编辑器站点提供，见[部署](#部署)。

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
- 代理只访问 `GITHUB_REPO` 配置的仓库。前端统一请求 `/api/github/repo`，旧仓库路由仅匹配同一个已配置仓库
- 端点白名单按**方法 + 路径**双重校验：`GET` 限仓库信息、ref、tree、blob、commit、`source/_posts|images` 下的 contents、compare；`POST` 限 blob / tree / commit / refs；`PATCH` 只允许 `main` 与 `draft/*`；`DELETE` 只能删 `draft/*`；`PUT` 一律不接受
- 写 `tree` 时路径必须落在 `source/_posts/` 或 `source/images/` 下，后缀与文件头都要对；`POST /git/refs` 的 `body.ref` 只能是 `refs/heads/draft/*`
- `PATCH` ref 要求新 commit 的父提交等于分支当前 head，`force` 只接受 `false`；冲突返回 `409`，编辑器据此提示重开草稿
- token 过期由函数用 refresh token 静默续期；续期失败返回 `401` 但**不清 Cookie**（并发续期时清 Cookie 会覆盖刚写入的新值），由前端弹「登录已过期」
- 授权失败会 302 回 `?auth=error&reason=…`，前端停在引导页显示原因，不会自动再跳授权页
- API 响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。通过子路径代理发布时，代理也为静态资源设置安全响应头

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
├── deploy/netlify/              Netlify Functions 和博客路由模板
├── test/
│   ├── run.mjs                  串行跑全部套件
│   ├── helpers.mjs              语料定位、选文、等待启动
│   ├── fixtures/posts/          4 篇内置样例
│   └── *.test.mjs               11 套测试
├── docs/
│   └── github-mode-plan.md      最初的设计稿（部分内容已被实现取代）
├── package.json                 仅测试需要；浏览器使用无需安装依赖
├── package-lock.json
└── README.md
```

三个脚本用最朴素的 `<script>` 顺序加载，共享 `window.HexoCore` / `window.GitHubStore`；`core.js` 是 UMD，Node 里可以直接 `require` 做单测。

按[部署](#部署)将随附的 Functions 放到处理编辑器登录和 API 的 Netlify 项目中。

---

## 测试

只需要 Node.js 18+：

```bash
npm ci                 # 只装测试依赖（jsdom / js-yaml / hexo-abbrlink）
npm test               # 自动找语料：相邻博客仓库的 source/_posts，找不到就用内置样例
npm run test:fixtures  # 强制用 test/fixtures/posts 的 4 篇样例
```

11 套测试：

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
| `netlify` | 用模拟请求验证目标仓库、授权回调及静态资源代理 |

补充说明：

- 语料目录可用 `HEXO_EDITOR_POSTS_DIR` 指定，默认按「相邻博客仓库 → 内置样例」的顺序查找；单套可 `node test/xxx.test.mjs` 直接跑
- 全部测试不发真实网络请求、不执行构建、不推送任何东西
- `github` 套件里的 `[草稿保存] Error: 远端文章已变更…` 是**故意制造冲突**的用例输出，不代表失败，看最后的 `Suites: 11, failed: 0`

---

## 部署

同一份前端可以复用到不同的 Hexo 博客。编辑器从当前域名请求 `/api/github/repo`，由该域名下的 Netlify Function 根据 `GITHUB_REPO` 选择博客仓库。示例里的 `blog.example.com` 是博客主站，`editor.example.com` 是独立编辑器站点。

### 选择部署方式

| 方案 | 用户打开的地址 | 编辑器文件发布到 | OAuth 回调、API 和环境变量配置在哪 |
|---|---|---|---|
| [A 随主站发布](#方案-a-随主站发布) | `https://blog.example.com/tools/online-hexo-editor/` | 博客主站 | 博客主站的 Netlify 项目 |
| [B 主站代理独立静态站](#方案-b-主站代理独立静态站) | `https://blog.example.com/tools/online-hexo-editor/` | 独立静态站，例如另一个 Netlify 项目或 GitHub Pages | 博客主站的 Netlify 项目 |
| [C 编辑器独立运行](#方案-c-编辑器独立运行) | `https://editor.example.com/` | 独立的 Netlify 编辑器项目 | 独立的 Netlify 编辑器项目 |

主站已在 Netlify 上、希望编辑器随博客一起更新，选 A。想保留现有主站入口，又想独立发布前端，选 B。希望编辑器有自己的入口和登录会话，选 C。

### 安装 Functions 和 API 路由

以下步骤在表中**处理 OAuth 和 API 的 Netlify 项目**里执行。

1. 从本仓库复制 [`deploy/netlify/functions/`](deploy/netlify/functions/) 到目标项目根目录的 `netlify/functions/`，保留 `lib/`。函数目录应在 Hexo 的 `source/` 和 Netlify 发布目录（通常为 `public/`）之外。
2. 以 [`deploy/netlify/netlify.toml`](deploy/netlify/netlify.toml) 为模板。目标项目已有 `netlify.toml` 时，合并相关配置。A、B 两种方案继续使用博客原有构建命令和发布目录。C 使用下文的静态构建配置。
3. 确认下面两条重写规则位于会匹配它们的通配规则之前，尤其是授权入口必须排在 `/api/github/*` 前面。OAuth 回调直接使用 Netlify 的函数地址。

```toml
[[redirects]]
  from = "/api/github/auth/start"
  to = "/.netlify/functions/github-auth-start"
  status = 200
  force = true

[[redirects]]
  from = "/api/github/*"
  to = "/.netlify/functions/github-api"
  status = 200
  force = true
```

`status = 200` 表示由 Netlify 在当前域名内重写请求。这样浏览器可以通过编辑器所在的域名请求 API，并发送该域名的会话 Cookie。[Netlify 重写文档](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)

### 方案 A 随主站发布

1. 将本仓库的 `index.html` 和整个 `assets/` 复制到博客仓库的 `source/tools/online-hexo-editor/`。
2. 在博客的 `_config.yml` 中把下面的条目合并到 `skip_render`，保留已有条目。Hexo 会原样复制这组文件。[Hexo 配置文档](https://hexo.io/docs/configuration)

   ```yaml
   skip_render:
     - "tools/online-hexo-editor/**/*"
   ```
3. 如果之前启用了两条 `/tools/online-hexo-editor` 静态代理规则，从主站的配置中移除它们。编辑器由 Hexo 的发布目录直接提供，`ONLINE_HEXO_EDITOR_UPSTREAM` 可留空。
4. 在主站配置下文的 GitHub App 和环境变量。按原有方式构建博客，确认 `public/tools/online-hexo-editor/index.html` 和同目录下的 `assets/` 已生成。部署完成后从主站编辑器入口登录。

### 方案 B 主站代理独立静态站

1. 在独立静态站点的发布目录放入 `index.html` 和 `assets/`，让它们分别可从站点的 `/index.html` 和 `/assets/` 访问。另开 Netlify 项目时，可以用 `public/` 作为发布目录，构建命令留空。这个项目只提供静态文件，GitHub App、Functions 和密钥都配置在博客主站。
2. 在博客主站的 `netlify.toml` 启用模板中两个编辑器代理规则，分别匹配 `/tools/online-hexo-editor` 和 `/tools/online-hexo-editor/*`，都以 `status = 200` 重写到 `/.netlify/functions/online-hexo-editor-proxy`。把两条规则放在博客的全站通配路由前。如果已有 A 方案的同名静态页面，迁移时从博客发布产物移除那一份，避免静态文件优先匹配。
3. 在**主站**的 Netlify 环境变量中设置 `ONLINE_HEXO_EDITOR_UPSTREAM`，填写能找到编辑器 `index.html` 的 HTTPS 目录地址。独立站点可填 `https://editor.example.com`，GitHub Project Pages 要带上仓库路径，例如 `https://<owner>.github.io/<repo>/`。如果希望主站只使用指定版本，填 Netlify 部署的永久地址，例如 `https://<deploy-id>--<site-name>.netlify.app`。[Netlify 部署永久链接](https://docs.netlify.com/manage/domains/domains-fundamentals/domains-glossary/)
4. 重新部署博客主站。从 `https://blog.example.com/tools/online-hexo-editor/` 登录。直接访问静态上游只会看到编辑器外壳，因为上游没有登录和仓库 API。

### 方案 C 编辑器独立运行

1. 创建一个单独的 Netlify 项目。将 `index.html` 和 `assets/` 放到该项目的 `public/`，将随附函数放到 `netlify/functions/`。
2. 将模板复制到独立项目的根目录，删除 `[build]` 中的 Hexo 构建命令，保留下面的发布目录和函数目录。Netlify 项目的构建命令也留空。保留模板中的两条 API 路由，编辑器静态代理规则保持注释。[Netlify 构建配置](https://docs.netlify.com/build/configure-builds/overview/)

   ```toml
   [build]
     publish = "public"
     functions = "netlify/functions"
   ```
3. 在**独立编辑器项目**配置 GitHub App 和环境变量。把 `GITHUB_AUTH_CALLBACK` 设为 `https://editor.example.com/.netlify/functions/github-auth-callback`，并在 GitHub App 中登记同一地址。因为编辑器从根路径打开，把 `GITHUB_AUTH_RETURN` 设为 `/`。静态上游变量留空。
4. 用户直接访问 `https://editor.example.com/`。博客主站可以链接这个地址。登录 Cookie 和浏览器本地暂存按站点分开，换到独立域名后需要重新登录，原域名里尚未保存到 GitHub 的内容也不会自动迁移。编辑器写入的仍是 `GITHUB_REPO` 指向的博客仓库，博客的构建继续由博客项目处理。

### 配置 GitHub App

1. 在 GitHub 的 **Settings → Developer settings → GitHub Apps** 创建 App。将 **User authorization callback URL** 设为处理登录的站点域名加上 `/.netlify/functions/github-auth-callback`。A、B 使用博客域名，C 使用编辑器域名。
2. 在 **Repository permissions → Contents** 选择 **Read and write**。关闭项目用不到的 Webhook，只将 App 安装到目标博客仓库。登录编辑器的 GitHub 用户也需要对该仓库有对应的读写权限。
3. 记录 App 的 **Client ID**，生成 **Client Secret**，填入下一节的环境变量。若一个 App 同时服务多个入口，在 GitHub App 中登记各入口的实际回调地址。[GitHub App 回调文档](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)

### 设置 Netlify 环境变量

在**处理 OAuth 和 API** 的 Netlify 项目打开 **Environment variables**。如界面提供作用域设置，选择包含 **Functions** 的作用域。修改环境变量后创建新的部署。[Netlify Functions 环境变量文档](https://docs.netlify.com/build/functions/environment-variables/)

| 变量 | 配置 |
|---|---|
| `GITHUB_REPO` | 必填。目标博客仓库，例如 `example-owner/example-blog`。方案 C 也填博客仓库。 |
| `GITHUB_APP_CLIENT_ID` | 必填。GitHub App 的 Client ID。 |
| `GITHUB_APP_CLIENT_SECRET` | 必填。GitHub App 的 Client Secret，只供 Functions 使用。 |
| `GITHUB_TOKEN_SECRET` | 必填。会话加密密钥，用下方命令生成，只供 Functions 使用。 |
| `GITHUB_AUTH_CALLBACK` | 必填。完整 HTTPS 回调地址，与 GitHub App 中登记的值一致。 |
| `GITHUB_AUTH_RETURN` | A、B 默认使用 `/tools/online-hexo-editor/`。C 从根路径打开时填 `/`。值为站内路径。 |
| `ONLINE_HEXO_EDITOR_UPSTREAM` | 仅 B 必填。在博客主站填写静态前端的 HTTPS 地址。 |

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

### 验证部署和排查故障

1. 在未登录窗口访问编辑器所在域名的 `/api/github/repo`。预期返回 `401` 和 `not signed in`。
2. 打开对应方案的编辑器入口，确认样式和脚本加载成功。完成 GitHub 授权后，确认回到同一个域名的编辑器，页面显示的仓库与 `GITHUB_REPO` 一致，并能加载文章和图片。
3. 在测试博客保存一篇草稿，确认 `draft/*` 分支出现而 `main` 尚未更新。再发布测试文章，确认 `main` 更新；如果博客项目连接了该仓库的 `main`，检查博客构建是否启动。

| 症状 | 检查项 |
|---|---|
| `/api/github/repo` 返回 404 | 确认访问的是实际编辑器入口所在域名。检查该 Netlify 项目是否已部署 Functions，以及是否加载了 API 路由。 |
| `GITHUB_REPO` 配置错误 | 检查值是否为 `owner/repo`，环境变量是否设置在运行 Functions 的项目，以及是否已创建新部署。 |
| `app_not_configured` / `token_secret_missing` | 检查 Client ID、Client Secret、回调地址和会话加密密钥。 |
| `state_mismatch` 或授权后回到错误页面 | 用最终入口域名重新发起登录，核对 GitHub App 的回调地址、`GITHUB_AUTH_CALLBACK` 和 `GITHUB_AUTH_RETURN`。 |
| 授权后查询仓库返回 404 | 检查 GitHub App 的安装范围和当前 GitHub 用户对目标仓库的权限。 |
| 页面打开但样式或脚本返回 404 | A 检查 Hexo 构建产物中的 `tools/online-hexo-editor/assets/`。B 检查两条主站代理规则及上游的 `/assets/`。C 检查 `public/assets/`。 |

---

## 日常升级与回滚

**从旧版升级**。A、B 方案先更新博客主站的代理和 Functions，再更新编辑器前端。新代理仍接受旧前端对已配置仓库的请求。更新后先检查主站的 `/api/github/repo` 能否返回预期的登录状态。

| 方案 | 更新和回滚 |
|---|---|
| A 随主站发布 | 更新博客仓库中随站发布的静态文件。部署有问题时，在主站 Netlify 项目重新发布之前的可用部署。 |
| B 主站代理独立静态站 | 先发布并验证上游的新版本。如果使用固定部署地址，更新主站的 `ONLINE_HEXO_EDITOR_UPSTREAM` 后重新部署主站。回滚时指回上一个可用的固定地址，再部署主站。 |
| C 编辑器独立运行 | 在独立编辑器项目一起更新前端和 Functions。回滚时在该项目重新发布之前的可用部署。 |

站点部署回滚不会撤销已经写入 GitHub 的文章变更。要恢复文章，先核对博客仓库中的发布提交，再对相应提交执行 `git revert`。

---

## 已知边界

- **编辑入口需要同源 API**。直接打开本地 HTML 或纯静态上游时，仅能加载前端文件。请从主站入口或带 Functions 的独立编辑器域名登录。
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

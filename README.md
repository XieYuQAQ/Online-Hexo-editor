# Hexo 文章编辑器 · ZEROKAMI

在线 Markdown 文章编辑器，直接读写你的 Hexo 博客仓库的 `source/_posts` 与 `source/images`。

- **在线地址**：<https://zerokami.cn/tools/online-hexo-editor>
- **工作方式**：文章改动存成 Git 分支草稿，发布时合并到 `main`，Netlify 自动构建上线
- **纯前端**：无构建步骤、无运行时依赖，浏览器直接运行

> 本项目是为 ZEROKAMI 定制的：图片路径、视频块、`abbrlink` 短链、主题字段都与本站约定一致，**不一定适用于其他 Hexo 博客**。

---

## 目录

- [能做什么](#能做什么)
- [分支模型与发布](#分支模型与发布)
- [文章编辑](#文章编辑)
- [图片管理](#图片管理)
- [安全模型](#安全模型)
- [项目结构](#项目结构)
- [测试](#测试)
- [部署](#部署)
- [已知边界](#已知边界)

---

## 能做什么

- **浏览**：列出仓库里全部文章，标题 / 日期 / 标签 / 摘要直接读自 front matter
- **编辑**：标题、描述、标签、分类、日期、封面，正文所见即所得
- **草稿**：改完保存到 `draft/<abbrlink>` 分支，不碰线上
- **发布**：单篇或批量，一次合并到 `main`（一次部署）
- **删除**：标记「待删除」→ 发布后从网站消失，可撤销
- **图片**：列表 / 点击预览 / 上传 / 引用检查删除 / 一键清理孤儿图 / 发布时自动确认孤儿图

---

## 分支模型与发布

| 位置 | 作用 |
|---|---|
| `main` | 已发布内容，编辑器内**只读** |
| `draft/<abbrlink>` | 草稿，一篇一分支；第一次保存才创建 |

发布不是 `git merge`，而是用 GitHub 的 Git Data API 构造**差量 tree**：

1. 以当前 `main` 的 tree 为底；
2. 只叠加本次改动的文件；
3. 生成一个 commit、更新 `main` 引用（不带 force）；
4. 删除已合并的草稿分支。

这样草稿即使落后于 `main`，也不会把其他文章回退；引用更新遇到冲突直接拒绝，不会只发一半。

**批量发布**：列表勾选多篇草稿，底部「发布选中 (N)」一次提交。N 篇 = 1 个 commit = 1 次 Netlify 部署。单次最多 20 篇。

**删除**：已发布文章点「删除」只是在草稿分支里把文件置空、标「待删除」，发布后才真正从 `main` 消失，发布前可「撤销删除」；从未发布过的草稿则直接删分支，不产生部署。

---

## 文章编辑

属性区直接对应 front matter：

- `title`（标题）
- `abbrlink`（短链，`crc32(title)` 的十六进制，与 `hexo-abbrlink` 一致，永久链接 `:abbrlink.html`）
- `date`、`description`、`cover`、`tags`、`categories`

正文是所见即所得，支持：

- 标题、加粗、斜体、删除线、行内代码、代码块、引用、列表、表格
- `![](图片)` 图片、`{% video %}` 视频块
- 工具栏插入、`Ctrl/Cmd + B/I/K` 等快捷键、`Ctrl + S` 保存

未保存的改动会进浏览器本地草稿，刷新后提示恢复。

---

## 图片管理

侧栏「图片」入口：

- **列表**：路径、大小、引用数、草稿来源、待删除标记
- **预览**：点击缩略图才拉原图（私有仓库没有服务端缩略图）
- **上传**：需打开一篇已保存的草稿，写入 `source/images/YYYY/MM/<10 位随机>.<后缀>` 并自动插入正文
- **删除**：仍被任何文本引用的图拒绝删除并展开引用列表；孤儿图进入「待删除」队列，随下一次发布一起提交
- **清理孤儿图**：一键把所有零引用图加入队列
- **发布时自动确认**：某张图因这次改动删掉了最后一个引用，发布前弹窗勾选是否一并删除

引用扫描覆盖仓库内所有文本文件（跳过 `node_modules` / `public` / `tools` / `package-lock.json`），结果缓存到浏览器本地并按版本增量更新；正文和封面里的图片直接从 GitHub 读 blob 预览，不依赖站点是否已构建。

---

## 安全模型

- 所有请求走同域 `/api/github/*`，由 Netlify Function 代理并注入 token
- token 存在 httpOnly cookie 里，浏览器脚本接触不到
- 代理只放行配置的那一个仓库
- 登录通过 `/api/github/auth/start` 整页跳转，回调后回到编辑器

---

## 项目结构

```text
hexo-editor/
├── index.html              界面入口
├── assets/
│   ├── core.js             格式层：front matter 解析/序列化、abbrlink、文件名、视频块（浏览器/Node 通用）
│   ├── github.js           GitHub 存储层：认证入口、分支/提交/发布、图片 blob
│   ├── app.js              编辑器主程序
│   └── editor.css          样式
├── test/                   7 套自动化测试
│   ├── run.mjs             测试入口
│   ├── fixtures/posts/     4 篇内置样例（独立运行用）
│   └── *.test.mjs          各测试套件
├── package.json            仅测试需要，浏览器使用无需安装依赖
├── package-lock.json
└── README.md
```

---

## 测试

仅运行测试需要 Node.js 18+。在本目录执行：

```bash
npm ci
npm test               # 用相邻博客仓库的 source/_posts
npm run test:fixtures  # 用 test/fixtures/posts 的 4 篇样例
```

7 套测试：

| 套件 | 内容 |
|---|---|
| roundtrip | 读入 → 序列化逐字节一致 |
| edit | front matter 字段编辑 |
| selectors | 静态选择器 / DOM 审计 |
| ui | 界面结构断言 |
| interact | 工具栏 / 快捷键 / 列表交互 |
| wysiwyg | 所见即所得渲染 |
| github | 内存 Git + mock fetch，覆盖列表、编辑保存、单篇与批量发布、删除与撤销、图片引用扫描、待删除队列、新建文章、草稿图预览、发布时孤儿图确认 |

- 需要检查其他语料时设置 `HEXO_EDITOR_POSTS_DIR`；单套可用 `node test/xxx.test.mjs` 运行
- 检查数随实际文章数量变化，以命令输出为准
- 测试不发真实网络请求、不执行构建、部署或推送

---

## 部署（本项目现状）

编辑器是纯静态站点，整个链路分三层：

```
浏览器
  └─ https://zerokami.cn/tools/online-hexo-editor/*   (Netlify，同域，cookie 能带上)
       └─ /.netlify/functions/online-hexo-editor-proxy → https://xieyuqaq.github.io/Online-Hexo-editor (GitHub Pages 静态站点)
       └─ /.netlify/functions/github-api            → https://api.github.com (注入 token、限定仓库)
       └─ /.netlify/functions/github-auth-*         → GitHub OAuth 授权
```

- 编辑器前端：push 到 `XieYuQAQ/Online-Hexo-editor`（GitHub Pages）
- 代理与认证：Netlify Function，源码在博客仓库的 `source/netlify/` 下（`hexo generate` 后落到 `public/netlify/`）
- 数据仓库：目标 Hexo 博客仓库（提供 `source/_posts`、`source/images`）

---

## 自托管：部署到自己的仓库

要把这套部署到你自己的站点和仓库，需要四样东西：**一个 GitHub App、一个 Netlify 站点、编辑器静态站点、目标仓库**。

### 1. 准备仓库与编辑器

1. Fork 本仓库（`XieYuQAQ/Online-Hexo-editor`），在仓库 Settings → Pages 开启 GitHub Pages（选 main 分支）。
2. 在 `index.html` 里、`assets/github.js` **之前**加一行，指定你的博客仓库：

```html
<script>window.HEXO_EDITOR_REPO = '你的用户名/你的仓库';</script>
```

（`github.js` 顶部写死了一个默认仓库名，改成你的即可。）

### 2. 创建 GitHub App

到 GitHub → Settings → Developer settings → GitHub Apps → New GitHub App：

| 项 | 填什么 |
|---|---|
| Homepage URL | 你的站点首页 |
| **User authorization callback URL** | `https://你的域名/.netlify/functions/github-auth-callback` |
| Webhook | 关掉（Active 不勾选） |
| Repository permissions → **Contents** | **Read and write** |
| Where can this app be installed | 仅你的账号（Any account 也行，看需求） |

建好后记下两样：**Client ID**、并生成一个 **Client secret**。

> 说明：代码里环境变量叫 `GITHUB_APP_*`，走的是 GitHub App 的 **user-to-server** 授权流（返回 `refresh_token`，支持续期）。使用者需要对这个 App 授权，且对目标仓库有 push 权限。

### 3. 部署 Netlify 函数

把这三个函数放到 Netlify 站点的 functions 目录（本仓库源文件在 `source/netlify/functions/`，Hexo 构建后是 `public/netlify/functions/`）：

- `github-auth-start.js` —— 跳转 GitHub 授权
- `github-auth-callback.js` —— 用 code 换 token，加密写进 httpOnly cookie
- `github-api.js` —— API 代理（校验登录态、注入 token、限定仓库、token 续期）

在 `netlify.toml` 里声明 functions 目录，并加三条重写（`auth/start` 必须排在 `/api/github/*` 通配之前）：

```toml
[build]
  functions = "netlify/functions"

[[redirects]]
  from = "/api/github/auth/start"
  to = "/.netlify/functions/github-auth-start"
  status = 200

[[redirects]]
  from = "/api/github/*"
  to = "/.netlify/functions/github-api"
  status = 200
```

如果要像本项目一样把编辑器挂在子路径下（`/tools/online-hexo-editor/`），再加编辑器代理（`online-hexo-editor-proxy.js`）：

```toml
[[redirects]]
  from = "/tools/online-hexo-editor/*"
  to = "/.netlify/functions/online-hexo-editor-proxy"
  status = 200

[[redirects]]
  from = "/tools/online-hexo-editor"
  to = "/.netlify/functions/online-hexo-editor-proxy"
  status = 200
```

### 4. 配置环境变量（Netlify → Site settings → Environment variables）

| 变量 | 说明 |
|---|---|
| `GITHUB_APP_CLIENT_ID` | GitHub App 的 Client ID |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App 的 Client secret |
| `GITHUB_TOKEN_SECRET` | 一段随机串（≥32 字节），用于 AES-256-GCM 加密 cookie 里的 token |
| `GITHUB_REPO` | 目标仓库 `owner/repo`（默认值写死在 `github.js` 里，改成你的） |
| `GITHUB_AUTH_CALLBACK` | 授权回调，默认 `https://你的域名/.netlify/functions/github-auth-callback` |
| `GITHUB_AUTH_RETURN` | 授权完成回跳地址，默认 `/tools/online-hexo-editor/?auth=ok` |
| `ONLINE_HEXO_EDITOR_UPSTREAM` | 编辑器静态站点地址，默认 `https://你的用户名.github.io/Online-Hexo-editor` |

`GITHUB_TOKEN_SECRET` 可用 `openssl rand -base64 32` 生成。

### 5. 校验

- 打开 `https://你的域名/tools/online-hexo-editor/` → 会自动跳 GitHub 授权 → 回调后回到编辑器
- 能列出仓库文章、编辑保存成 `draft/*` 分支、发布合并到 `main`，即成功

**常见坑**：

- `/api/github/auth/start` 一定要写在 `/api/github/*` 前面，否则会被通配吞掉
- 授权回调 URL 必须和 GitHub App 里登记的一字不差（包括路径和协议）
- 编辑器代理会给 HTML 注入 `<base>`，让 `assets/` 等相对路径解析回子路径；不要在这层再加别的缓存策略（JS/CSS 已设为 `no-cache, must-revalidate`）

---

## 已知边界

- **只在 `zerokami.cn` 域可用**：`file://` 收不到 OAuth 回调，GitHub Pages 域带不上同站 cookie
- 私有仓库没有服务端缩略图，图片首次预览要从 GitHub 拉原图（之后按 sha 缓存）
- 不做图片重命名 / 移动，不做发布冲突自动合并（冲突直接拒绝）
- 一次批量发布最多 20 篇
- 首次打开图片管理需要全量扫一遍引用（必须读一遍文本才知道引用关系），之后走缓存/增量

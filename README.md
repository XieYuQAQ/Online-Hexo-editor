# Hexo 文章编辑器 · ZEROKAMI

在线 Markdown 文章编辑器，直接读写 ZEROKAMI 博客仓库 `XieYu-Zk/ZEROKAMI-STUDIO` 的 `source/_posts` 与 `source/images`。

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

## 部署

- 编辑器本体是纯静态站点，push 到 `XieYuQAQ/Online-Hexo-editor`（GitHub Pages）
- `https://zerokami.cn/tools/online-hexo-editor` 由 Netlify 代理该 Pages 地址
- Netlify Function 提供 `/api/github/*`（GitHub 代理 + 认证）与 `/comment/*`（Waline 评论代理）

---

## 已知边界

- **只在 `zerokami.cn` 域可用**：`file://` 收不到 OAuth 回调，GitHub Pages 域带不上同站 cookie
- 私有仓库没有服务端缩略图，图片首次预览要从 GitHub 拉原图（之后按 sha 缓存）
- 不做图片重命名 / 移动，不做发布冲突自动合并（冲突直接拒绝）
- 一次批量发布最多 20 篇
- 首次打开图片管理需要全量扫一遍引用（必须读一遍文本才知道引用关系），之后走缓存/增量

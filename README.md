# API MCP v2.0.0

Windows 版本地 API 设计与调试工具，内置 MCP 服务。自带数据目录，不依赖任何其它软件。

## 特性

- **34 个工具** — `apimcp_list_projects` … `apimcp_export_project`
- **开箱即用** — 首次启动自动建好数据目录和一个「默认项目」，打开就能写接口
- **导入导出** — 导入 OpenAPI 3.x / Swagger 2.0 / Postman Collection v2.1 / HAR / cURL，以及 AI 解析任意文本与请求代码；导出 OpenAPI 3.0（JSON / YAML）、Postman v2.1、Markdown、HTML、Word
- **设计与调试分离** — 「设计」页只定义契约（参数表含类型 / 必填 / 示例值 / 描述、Body 结构、响应结构），不发送请求；「调试」页上下分栏（上方请求构建区 + 下方常驻响应区），真实发送并查看结果
- **顶部多标签页** — 多个接口同时打开、随时切换与关闭，每个标签页各自保留未保存草稿
- **接口树交互对齐 Apipost** — 双击就地改名、右键菜单（目录与接口两套，带图标与分组）、搜索过滤、目录折叠、拖拽排序与跨目录移动
- **8 个请求页签** — Header / Query / Path / Body / 认证 / Cookie / 预执行操作 / 后执行操作，页签上带启用参数计数
- **form-data 结构化编辑** — 表头对齐的参数表，值列内嵌类型下拉，支持文件选择与逐字段内容类型
- **可视化断言** — 12 种数据源 × 15 种条件，配置在「后执行操作」里，结果在响应区就地展示
- **分阶段耗时** — 点响应耗时展开 8 段明细（Request / Socket / Lookup / Connect / SecureConnect / Response / End / Done）
- **代码生成** — 一键把当前请求转成 cURL / fetch / axios / Python / Go / Java 六种可运行代码
- **自动化测试** — 执行计划编排，支持条件 / 次数 / While / 等待 / 脚本五种控制器任意嵌套，运行后输出可视化报告
- **AI 辅助（可选）** — 兼容 OpenAI 风格的任意服务：AI 解析导入、AI 起草接口、AI 生成测试用例
- **环境管理** — 多环境切换、环境变量、多 host 服务（前置 URL）；目录可指定服务，其下接口优先使用
- **全局参数与全局变量** — 全局 / 目录 / 接口三层继承（Header、Query、Body、鉴权、前后置脚本），环境变量优先于全局变量
- **参数批量编辑** — 贴一段「参数名: 参数值」或扁平 JSON，左侧输入右侧实时预览，支持命名风格转换
- **完整 apt 脚本沙箱** — `apt.environment/globals/variables`、`setRequestHeader/Query/Body`、`response.json/text`、`cookies`、`apt.test/apt.expect`
- **Apipost 同款主题** — 暖纸金（默认）/ 暗色 / 自定义底色，配色取自 Apipost 主题 token
- **双模式** — 常驻 HTTP 服务（含 Web 控制台）+ `--stdio`（供 MCP 客户端直连）
- **完全独立** — 数据全部落在自己的目录里，不读写本机任何其它软件的文件
- **单文件交付** — `dist/apimcp.exe`，运行时零依赖
- **可选的桌面端** — Electron 独立窗口，双击即用，不需要浏览器标签页

## 快速开始（用打包好的 exe）

不需要装 Node，也不需要 `npm install`，直接拿产物即可：

| 产物 | 位置 | 适合谁 |
|---|---|---|
| **桌面端（独立窗口）** | `dist/desktop/ApiMCP-Desktop-win32-x64.zip` | 想要一个像普通软件那样的窗口（zip 内已含 `apimcp.exe`） |
| **命令行 / 浏览器版** | `dist/apimcp.exe` | 给 AI 客户端当 MCP 服务用，或习惯在浏览器里操作 |

两者数据完全共享，用哪个都行，也可以同时用。

## 功能地图

| 我想… | 去哪 |
|---|---|
| 写接口、改参数、发请求 | 接口设计 → 设计（定义契约）/ 调试（发送与看响应） |
| 同时编辑多个接口 | 接口设计：点左树打开到新标签页，顶部标签栏随时切换 |
| 改接口名、删除、复制、拖到别的目录 | 接口设计左树：双击改名、右键菜单、拖拽 |
| 把接口定义复制成 cURL | 接口设计左树右键接口 → 复制为 cURL |
| 按文本批量录入参数 | 任一参数区标题右侧「批量编辑」 |
| 给接口加校验 | 接口设计 → 调试 → 后执行操作 → 断言 |
| 看各阶段网络耗时 | 接口设计 → 调试：点响应区的耗时数字 |
| 把请求转成 Java / Go / Python 代码 | 接口设计 → 调试 → 生成代码 |
| 把多个接口串成流程、加条件与循环 | 自动化测试 |
| 把文档发给别人 | 导入导出 → 导出 Markdown / HTML / Word，或「打开文档页」打印成 PDF |
| 导入别人给的接口文档 | 导入导出 → 粘贴内容或上传文件 |
| 粘贴一段 Java 代码或网页文字变成接口 | 导入导出 → 格式选「AI 解析」（需先启用 AI） |
| 一句话生成一个接口 | 接口设计工具条 →「✦ AI 起草接口」 |
| 批量生成测试用例 | 接口设计 → 接口用例 →「✦ AI 生成用例」 |
| 切换环境、改变量 | 环境与变量 |
| 让 Cursor 等 AI 客户端调用这些接口 | 客户端配置 |
| 打开或关闭 MCP 服务 | 总览

### 前置条件

无需任何前置条件。**首次启动会自动创建数据目录 `%APPDATA%\ApiMCP\data\` 和一个名为「默认项目」的项目**，打开控制台即可直接写接口。

> 想把数据放在别处（含绿色便携）：用 `--data-root` 指定，或在控制台「外观设置 → 数据目录」里改，或设环境变量 `APIMCP_HOME` 让配置与数据一起跟着目录走。

### 方式一：`apimcp.exe`（浏览器控制台）

**双击运行**即可，它会：

1. 起一个本地服务（默认 `127.0.0.1:39100`）
2. 自动用系统默认浏览器打开控制台，地址形如 `http://127.0.0.1:39100/?ui=<token>`

终端里会打印这些信息，其中 `?ui=<token>` 就是控制台入口，**不要漏掉**（没有 token 打不开控制台）：

```
  API MCP 服务已启动
  数据目录: C:\Users\<你>\AppData\Roaming\ApiMCP\data（首次已初始化）
  控制台  : http://127.0.0.1:39100/?ui=xxxxxxxx
  MCP 端点: http://127.0.0.1:39100/mcp
  Token   : xxxxxxxx
  配置    : C:\Users\<你>\AppData\Roaming\ApiMCP\config.json
```

> 双击后如果只弹出一个黑框，说明服务已在运行，**别关这个窗口**——关了服务就停了。

```powershell
# 常用启动方式
.\apimcp.exe                         # 起服务 + 打开浏览器
.\apimcp.exe --serve                 # 只起服务，不打开浏览器
.\apimcp.exe --serve --port 39101    # 换端口
.\apimcp.exe --data-root "D:\data"   # 指定数据目录
.\apimcp.exe --help                  # 查看全部参数
```

**首次使用建议顺序**：双击 exe → 浏览器打开控制台（已有「默认项目」，可直接开写）→「总览」打开 **MCP 服务开关**（默认关闭）→ 勾选要开放的项目 → 开始用。

> 服务默认处于**停用**状态，首次使用需要手动打开「总览」里的运行开关；开启后 HTTP 与 stdio 两种接入方式才可用。
>
> 「默认项目」只是省去第一步，可以改名、删除，也可以再建更多项目。
### 方式二：`ApiMCP-Desktop.exe`（独立窗口）

双击 `ApiMCP-Desktop.exe` 即可，无地址栏、无标签页，关窗口等于关这个软件。

> 分发时把 `ApiMCP-Desktop-win32-x64.zip` 整个发出去，或**整个 `ApiMCP-Desktop-win32-x64` 目录一起拷贝**（约 360 MB，含 Electron 运行时与 `apimcp.exe`）。只拿一个 exe 会打不开。

它和你已有的 `apimcp.exe` 的关系：

| 情况 | 行为 |
|---|---|
| 39100 端口空闲 | 桌面端自己起服务，**关窗口即停服务** |
| `apimcp.exe` 已在跑 | 自动「附着」，只开窗口，**关窗口不影响那边** |
| 端口被别的程序占了 | 弹窗提示，用 `--port` 换端口 |

桌面端支持同样的 `--port` / `--data-root`。

```powershell
# 用快捷方式或命令行带参数启动
ApiMCP-Desktop.exe --port 39101
```

### 配到 AI 客户端（Cursor / Claude Code / VS Code / Trae / Codex）

不用手写配置：打开控制台 → 左侧「**客户端配置**」→ 选你的客户端 → 点复制 → 粘到对应文件里。

以 Cursor 为例，粘到 `%USERPROFILE%\.cursor\mcp.json`：

```json
{
  "mcpServers": {
    "apimcp": {
      "command": "D:\\path\\to\\dist\\apimcp.exe",
      "args": ["--stdio"]
    }
  }
}
```

> `--stdio` 由客户端自己拉起进程，**不需要**先双击 exe。`command` 要写**绝对路径**。

### 数据在哪

| 内容 | 路径 |
|---|---|
| 项目数据（读写） | `%APPDATA%\ApiMCP\data\` |
| 本软件配置 | `%APPDATA%\\ApiMCP\config.json` |
| 桌面端窗口位置记忆 | `%APPDATA%\\ApiMCP\desktop-window.json` |

首次启动自动创建，改动直接写入该目录，保存即时生效。

数据目录内部结构（沿用 Apipost 的序列化格式，便于按需导入导出）：

```
%APPDATA%\ApiMCP\data\
├─ offline-projects.json       项目索引
├─ offline-data\{project_id}\  各项目数据（project.json / apis / envs / global_params / settings / executions）
└─ offline-data-local\         本地元信息（meta.json 默认团队、teams.json、projects\ 运行时变量）
```

## 全局参数与变量

控制台「环境与变量」页分三个页签：环境、全局参数、全局变量，每个页签底部都有一段可折叠的使用说明。

### 变量引用

任何参数值、URL、Body、鉴权、脚本里都可以用 `{{变量名}}` 引用变量；变量值本身还能再嵌套 `{{...}}`，最多递归 5 层（防死循环）。

内置变量无需定义，每次渲染即时生成：

| 变量 | 说明 |
|---|---|
| `{{$timestamp}}` | 秒级时间戳 |
| `{{$timestampMs}}` | 毫秒时间戳 |
| `{{$randomInt}}` | 0-999 随机整数 |
| `{{$uuid}}` / `{{$guid}}` | 随机 UUID |
| `{{$isoDate}}` | ISO 8601 时间 |

### 环境变量与全局变量

| 层级 | 生效范围 | 位置 |
|---|---|---|
| **环境变量** | 只在当前环境生效 | 「环境与变量 → 环境」的变量表 |
| **全局变量** | 整个项目生效 | 「环境与变量 → 全局变量」 |

取值优先级（高 → 低）：

```
环境 current_value > 环境 value > 全局 current_value > 全局 value
```

「默认值」是基线配置，「当前值」是运行时实际取用的值；脚本 `apt.environment.set` / `apt.globals.set` 写入的是当前值，清空当前值会回落到默认值。

### 全局参数

全局参数对项目下每个接口生效，按「全局 → 目录 → 接口」三层继承：

- **Header / Query**：按 key 求并集，同名内层优先；内层取消勾选（`is_checked = -1`）表示禁用外层同名项
- **Body**：只支持 `form-data` 与 `urlencoded`
- **鉴权**：从内往外找第一个不是 `inherit` 的类型
- **脚本**：前置按 `全局 → 目录 → 接口`，后置按 `接口 → 目录 → 全局`

### Cookie 写法

两种写法都支持，但**不要同时用**：

| 方式 | 位置 | 说明 |
|---|---|---|
| Cookie 参数表 | 接口 / 目录 / 全局参数的「Cookie」页签 | 按 key-value 逐条填写，发送时拼成一条 `Cookie` 头 |
| Header 的 `Cookie` 键 | 任一参数区的 Header 表 | 直接写 `a=1; b=2` |

**冲突规则**：执行层只在**没有** `Cookie` 请求头时才用 Cookie 表拼头（`src/exec/http.js`）。两者同时存在时以 Header 为准，Cookie 表静默不生效——界面会在 Cookie 页签顶部显示黄条提示，并提供「删掉 Header Cookie」与「迁到 Cookie 表」两个按钮。

粘贴 cURL（`-b` / `--cookie` / `-H 'Cookie: ...'`）或导入 OpenAPI 时，cookie 会自动合并成一条 `Cookie` 请求头。

### 跨步骤传值

在登录接口的后置脚本里写入变量，后续接口用 `{{...}}` 引用：

```js
// 步骤 1 后置脚本
apt.environment.set("token", apt.response.json().token);
```

```
// 步骤 2 的 Header
x-access-token: {{token}}
```

## 从源码构建

```powershell
npm install
npm run build          # → dist/apimcp.exe
npm run build:desktop  # → dist/desktop/ApiMCP-Desktop-win32-x64/ + 同名 zip（约 6 分钟）
```

> `build:desktop` 会把 `dist/apimcp.exe` 一起拷进桌面端目录并打成 zip，所以先跑 `build` 再跑 `build:desktop`。产物大小约：`apimcp.exe` 89 MB、桌面端 zip 184 MB。

改完 `web/` 下的任何文件后必须重跑 `npm run build`（或 `node scripts/gen-assets.mjs`），因为控制台资源是内联进 exe 的。

新增前端脚本要同步改三处：`web/index.html` 的 script 标签、`scripts/gen-assets.mjs` 的 `files` 数组、`src/server/serve.js` 里静态资源路由的正则。当前脚本清单：`app.js` / `design.js` / `workspace.js` / `envvars.js` / `transfer.js` / `extra.js` / `recent.js` / `automation.js` / `curl-parse.js` / `curl-build.js` / `codegen.js`。

## 接口树交互

「接口设计」左侧的树按 Apipost 的方式操作：

| 手势 | 行为 |
|---|---|
| 单击 | 打开到新标签页（已打开则激活） |
| **双击名称** | 就地改名，回车或失焦立即落库，Esc 取消 |
| **右键** | 弹出菜单（见下表） |
| 拖拽 | 拖到目录行中间 = 移入该目录；拖到行的上 / 下缘 = 同级插入前后；禁止把目录拖进自己的子树 |
| 点折叠箭头 | 收起 / 展开该目录（重绘后保持） |

顶部搜索框按名称、URL、方法或 ID 过滤，命中的节点会连同祖先链一起保留；没有命中时显示「没有匹配的接口」。

树栏底部常驻的「+ 新建」跟随列表最后一行，滚到底就能看到——它像普通节点一样参与树的排布，不额外占用侧栏高度。

### 右键菜单

目录与接口是两套不同的菜单，均带图标与分组分割线。

**目录**

| 项 | 说明 |
|---|---|
| 新建 ▸ | 子菜单：接口 / 目录 / 文档 |
| 粘贴接口/文本 | 粘贴内容解析后在该目录下创建 |
| 全部运行 | 串行执行该目录下全部接口，带 `N/M` 进度与「停止」 |
| 分享 ▸ | 子菜单：复制文档链接 / 打开只读文档页（导出该目录及其子目录） |
| 移动至 ▸ | 子菜单列出全部目录，选中即移动 |
| 复制 | 仅复制目录自身，不含子内容 |
| 编辑 | 打开该目录 |
| 删除 | 连同其下所有内容一起删除 |

**接口 / 文档**

| 项 | 说明 |
|---|---|
| 分享 ▸ | 子菜单：复制文档链接 / 打开只读文档页（只含该接口） |
| 复制为 cURL ▸ | 子菜单：Bash / CMD，直接从接口定义合成，无需先发一次请求 |
| 外部调用 OpenAPI | 复制该接口的 OpenAPI 3 片段，可直接交给第三方或导入其他平台 |
| 移动至 ▸ | 子菜单列出全部目录 |
| 复制 | 同目录生成一份「xxx 副本」 |
| 克隆 | 连同子内容递归深拷贝到根目录 |
| 删除 | danger |

置灰项鼠标悬停会显示具体原因，点击只弹提示、不执行动作——避免「点了没反应」的困惑。

「分享」生成的链接指向本机的只读文档页（`/doc?project=...&api=...`），只在本地服务运行期间有效；它不含云端协作能力。

### 标签页

顶部标签栏的操作：

| 手势 | 行为 |
|---|---|
| 单击 | 切换到该标签 |
| 点 `×` | 关闭该标签（有未保存改动会确认） |
| **右键** | 关闭 / 关闭其他 / 关闭右侧 / 复制名称 / 复制接口 URL / 复制为 cURL ▸ |
| 右端 `⋯` | 关闭所有标签 / 强制关闭所有标签 / 关闭其他标签 / 强制关闭其他所有标签 / 保存所有标签 |

「强制关闭」跳过未保存确认。「保存所有标签」会把所有标签的设计域一起落库；用例与 Mock 草稿只存在于当前激活的接口，那部分需要切过去单独保存。

### 复制 / 克隆 / 另存为的区别

| 动作 | 范围 | 落点 |
|---|---|---|
| 复制 | 仅自身（目录不带子内容） | 同目录 |
| 克隆 | 整棵子树递归深拷贝 | 根目录 |
| 另存为（保存按钮下拉） | 仅自身 | 用户选择的目标目录 |

「复制」与「克隆」的参数、Body、鉴权、脚本、用例与 Mock 一并带走。

元信息栏的字段顺序是：**接口名称 → 状态 → 目录 → 标签**。改「接口名称」时侧栏标题实时跟随。

### 保存按钮的位置

「保存」在请求行的右端（原来的「curl 导入」位置），文案随页签变化（保存 / 保存用例 / 保存 Mock），右侧的 `▾` 下拉里是「另存为」与「删除」。设计页没有可发送的请求行，保存按钮挂在顶部契约地址行（Method / URL / 协议）的右端；用例与 Mock 面板底部另有一份自己的保存按钮。切换模式时按钮跟着重建。

模式页签行的右端现在是「curl 导入」，未保存徽标（`未保存 · 用例未保存 · Mock 未保存`）也在那一行。

顶部工具栏只保留「+ 新建」与「✦ AI 起草接口」两个新建类入口。

## 设计与调试

「接口设计」页签下，设计与调试是两个独立的模式页签，职责不同：

| 模式 | 定位 | 内容 | 能否发送 |
|---|---|---|---|
| **设计** | 契约定义 | 参数表（参数名 / 类型 / 必填 / 示例值 / 描述）、Body 结构、响应结构 | 否 |
| **调试** | 发送调试 | 上下分栏：上方请求构建区，下方常驻响应区 | 是 |

### 设计页

单栏文档式布局，用于把接口「该长什么样」说清楚，不提供发送按钮。参数表比调试页多了两个契约字段：

- **类型**：`String / Integer / Number / Boolean / Array / Object / File`
- **必填**：勾选后会写进导出文档的 `required`（OpenAPI 的 `required` 数组取自这里）

### 示例值 vs 实际值

设计页的「示例值」写在 `parameter[].example_value`，调试页实际发送用的是 `parameter[].value`，两者互不影响。改示例值不会改变真正发出去的请求。

导出文档时优先取示例值，老数据（只有 `value`）会自动回落，因此升级不会让已有文档的示例列变空。

### 调试页

上下分栏，中间横向拖拽条可调整高度（默认 60% / 40%，记在 `localStorage`）。请求区在上、响应区在下，两块都能在自己的区域内滚动。

请求页签共 8 个，页签上带启用参数计数：`Header` / `Query` / `Path` / `Body` / `认证` / `Cookie` / `预执行操作` / `后执行操作`。

响应区也是常驻的，6 个页签：`实时响应` / `响应头` / `Cookie` / `响应示例` / `实际请求` / `控制台`。响应按接口缓存在内存里，切走再切回来还在（刷新页面清空，不落盘）。

### 分阶段耗时

点响应区的耗时数字展开 8 段明细：

| 段 | 含义 |
|---|---|
| Request | 发出请求 |
| Socket | 分配套接字 |
| Lookup | DNS 查询 |
| Connect | TCP 建连 |
| SecureConnect | TLS 握手（仅 https） |
| Response | 等待首字节（TTFB） |
| End | 下载响应体 |
| Done | 端到端总计 |

各段刻意做成**不重叠**，因此条形图可以直接堆叠相加。HTTP/2 与历史记录没有分阶段数据，只显示总计。

> 为了采集这些数据，HTTP/1.1 请求走 `src/exec/timed-request.js`（基于 `node:http(s)`），而不是 `fetch`——`fetch` 不暴露 DNS / TCP / TLS 各阶段。HTTP/2 与显式注入 `fetchImpl` 的场景仍走 `fetch`。

## 断言

断言配置在「后执行操作」页签里，是接口校验规则的唯一入口。执行顺序：先跑后置脚本（脚本可能写入变量），再按顺序判定断言。

### 任务结构

断言与自定义脚本共用 `request.post_tasks`，靠 `type` 区分——脚本执行器只认 `customScript`，所以断言不会被误当脚本执行：

```json
{
  "id": "as_xxx",
  "type": "assert",
  "name": "业务码为 0",
  "enabled": 1,
  "data": {
    "source": "response_json",
    "expression": "$.code",
    "condition": "equal",
    "value": "0",
    "description": "业务码为 0"
  }
}
```

### 12 种数据源

| 数据源 | 表达式 | 说明 |
|---|---|---|
| `status_code` | 空 | 响应状态码 |
| `elapsed_time` | 空 | 总耗时（ms） |
| `content_type` | 空 | Content-Type 头 |
| `response_header` | Header 名 | 大小写不敏感 |
| `response_cookie` | Cookie 名 | 读 `Set-Cookie` |
| `response_json` | JSONPath | `$` / `.a` / `['a']` / `[0]` / `[*]` |
| `response_text` | 空 | 响应全文 |
| `response_xml` | 标签路径 | 如 `/root/name`，不支持命名空间与属性 |
| `response_schema` | `default` 或示例 ID | 按期望的 JSON Schema 递归校验 |
| `var` | 变量名 | 运行期临时变量 |
| `env_var` | 变量名 | 环境变量 |
| `global_var` | 变量名 | 全局变量 |

JSONPath 是精简实现：不支持 `..` 递归下降与过滤器，复杂场景请用后置脚本的 `apt.expect`。

### 15 种条件

`equal` / `not_equal` / `include` / `not_include` / `regex` / `gt` / `lt` / `gte` / `lte` / `length_equal` / `exists` / `empty` / `type_is` / `schema_match` / `schema_not_match`

`equal` 是宽松比较：`200` 与 `"200"` 视为相等，对象与 JSON 字符串会解析后再比。

### 向后兼容

旧接口的 `response.is_check_result` + `example[].expect` 结构校验**仍然生效**，未迁移的接口行为零变化。「后执行操作」页签在检测到该标记时会显示「迁移为断言」按钮，可把状态码 / Content-Type / 响应头 / Schema 转成断言行并置 `is_check_result = -1`。迁移是显式操作，不会静默改变既有校验。

## 代码生成

调试页的响应区有「生成代码」按钮，把本次实际发出的请求转成六种可运行代码：

| 语言 | 产出 |
|---|---|
| cURL | bash 方言，与「复制为 cURL」保持一致 |
| JavaScript | `fetch` / `axios` 两种写法 |
| Python | `requests` |
| Go | `net/http` |
| Java | `OkHttp` |

请求里的 `{{变量}}` 会原样保留，不会解析成实际值——粘到代码里后由你自己决定怎么注入。`form-data` 与 `binary` 这类无法用文本还原的模式会给出 warning，而不是编造一份假数据。上次选的语言会记住。

## 自动化测试

控制台左侧「自动化测试」把多个接口串成一条业务流程，支持控制器嵌套，运行后看可视化报告。

### 节点类型

| 类型 | 说明 |
|---|---|
| 接口步骤 | 引用项目里的 HTTP 接口，保存时固化一份快照，之后改接口不影响已排好的步骤 |
| 条件控制器 | 填 JS 表达式，为真走「成立时」分支，否则走「否则」分支 |
| 次数控制器 | 按指定次数重复执行子节点，循环体内可用 `{{$index}}`（从 0 起）/ `{{$iteration}}`（从 1 起） |
| While 控制器 | 每轮开始前求值，为真继续循环；`max_iterations` 兜底防死循环，达到上限会强制退出并在报告里提示 |
| 等待控制器 | 延迟指定毫秒 |
| 脚本控制器 | 只跑脚本不发请求，断言照常收集 |

### 条件怎么写

条件是一个 JS 表达式，可用对象与脚本沙箱完全一致：

```js
apt.response.code() === 200
apt.response.json().code === 0
apt.variables.get("token") !== ""
apt.response.json().data.length > 0
```

### 跨步骤传值（自动化计划内）

在步骤的后置脚本里写入变量，后续步骤用 `{{...}}` 引用：

```js
// 第 1 步（登录）的后置脚本
apt.environment.set("token", apt.response.json().token);
```

```
// 第 2 步的 Header
x-access-token: {{token}}
```

### 失败策略

默认「失败继续」——某步失败后仍执行后续步骤，便于一次看清整条链路哪里断了。勾选「失败即停」后，第一个失败会中止剩余步骤，被跳过的节点在报告里标记为「跳过」而不是静默丢弃。

### 执行报告

报告与计划结构同构：控制器按层级展开，循环能看到每一轮的子节点，条件会显示求值结果与走了哪个分支。每个节点给状态、耗时、状态码、断言明细与错误信息。

### 兼容性

历史计划里的步骤没有 `type` 字段，一律按普通接口步骤执行，**不需要迁移**，老计划可以直接跑。

## AI 辅助（可选）

默认关闭。到「外观设置 → AI 设置」填 API 地址、模型与 API Key 后启用。

任何 OpenAI 风格的服务都能接：

| 服务 | API 地址 | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5` |

填完可点「测试连通性」验证。

### 三个能力

| 入口 | 作用 |
|---|---|
| 导入导出 → 格式选「AI 解析」 | 粘贴任意内容（自然语言描述、Java / Go / .NET / Python 请求代码、网页复制的文档片段），提取成可调试的接口 |
| 接口设计工具条 →「✦ AI 起草接口」 | 一句话描述需求，生成方法、URL、参数、Body 与响应示例 |
| 接口用例面板 →「✦ AI 生成用例」 | 基于接口参数与响应示例设计正常 / 异常用例 |

三者都是「先生成、预览、确认后才落库」，AI 产生的内容不会直接写进项目数据。

### 安全说明

- API Key 以**明文**保存在 `%APPDATA%\ApiMCP\config.json`，与本服务的 MCP token 同级保护。服务只监听 `127.0.0.1` 且所有 `/api/*` 都需要 `ui_token`，但请勿在共享机器上填写。
- `publicConfig` 接口**只返回 `has_api_key` 布尔值**，Key 永远不会回传给前端，也不会出现在错误信息或日志里。
- 启用后，相关请求内容会发送到你填写的那个第三方地址。

## 导入导出

控制台「导入导出」页，或 MCP 工具 `apimcp_import_project` / `apimcp_export_project`。

### 导入

| 格式 | 支持范围 |
|---|---|
| OpenAPI 3.x | JSON 或 YAML；`in: cookie` 参数会合并成一条 `Cookie` 请求头 |
| Swagger 2.0 | 自动升级成 OpenAPI 3.0：`host`+`basePath`+`schemes` → `servers`，`definitions` → `components.schemas`，`in: body` / `in: formData` → `requestBody` |
| Postman Collection v2.0 / v2.1 | 嵌套目录还原成目录层级；`raw` / `urlencoded` / `formdata` / `graphql` body；`bearer` / `basic` / `apikey` / `oauth2` 鉴权 |
| HAR 1.2 | `log.entries[]` 逐条转成接口；按 `mimeType` 决定 body 模式 |
| cURL | bash（`\` 续行）、CMD（`^` 续行）、PowerShell（反引号 / `curl.exe`）三种方言；支持多条 curl 一起导入 |
| AI 解析 | 任意文本 / 请求代码；需先启用 AI（见上文），结果先预览再落库 |

流程是「先预览再落库」：预览只解析不写盘，会给出格式、接口数、目录数、前 50 条明细与 warnings（例如 Postman 里用到的变量尚未定义）。

同名接口判定由 `api_cover_mode` 决定：

| 模式 | 行为 |
|---|---|
| `url_and_folder`（默认） | 同目录 + 同方法 + 同 URL 视为同一接口，覆盖更新 |
| `url` | 只要同方法 + 同 URL 就覆盖，跨目录也命中 |
| `ignore` | 已存在则跳过，只新建缺失的 |
| `both` | 一律新建，允许重复 |
| `clear` | 先清空目标目录下的接口再导入 |

另外 `folder_id` 可以指定导入到某个目录（默认项目根目录），`base_path` 可以把 `servers[0].url` 拼到每个接口 URL 前面。

### 导出

| 格式 | 说明 |
|---|---|
| `openapi` | OpenAPI 3.0.3 JSON |
| `openapi_yaml` | OpenAPI 3.0.3 YAML（同一份结构，便于阅读与版本管理） |
| `postman` | Postman Collection v2.1 |
| `markdown` | Markdown 文档，适合放进代码仓库 |
| `html` | 自包含 HTML，离线可开，用浏览器打印即可存成 PDF |
| `word` | Word 文档（`.doc`，Word / WPS 直接打开） |

OpenAPI / Postman 只导出 HTTP 接口；目录层级会转成 OpenAPI 的 `tags` 或 Postman 的嵌套目录，导回去能还原结构。`servers[0]` 取当前环境默认服务（`server_id=1`）的地址。

导出的 OpenAPI 可以再被导入回同一项目，会命中原有接口（`updated` 而不是重复 `created`），往返一致性由 `test/io.test.mjs` 覆盖。

### 文档导出与只读文档页

三种文档格式（Markdown / HTML / Word）内容一致：按目录分组，每个接口给出方法、URL、状态、标签、说明、参数表（Header / Query / Path）、Body 与响应示例。空壳的默认响应示例会被跳过，不会塞一个假的 `{}` 进文档。

导出页还有「打开文档页」按钮，打开 `http://127.0.0.1:<port>/doc?project=<项目ID>&ui=<token>`——一个只读、自包含的 HTML 页面，带打印样式，浏览器里直接「打印 → 另存为 PDF」就能交付给非开发的同事。因为这是本地单机服务，「分享」等于在本机打开或打印，不做公网托管。

## 命令行

| 参数 | 说明 |
|---|---|
| （无参数） | 启动常驻服务 + 自动打开控制台 |
| `--stdio` | 作为 stdio MCP 服务运行（客户端拉起） |
| `--serve` | 只启动 HTTP 服务，不开浏览器 |
| `--no-open` | 不自动开浏览器（其余行为同无参数） |
| `--open` | 强制打开浏览器 |
| `--data-root <dir>` | 指定数据目录（默认 `%APPDATA%\ApiMCP\data`） |
| `--port <n>` | 监听端口（默认 39100） |
| `--version` / `--help` | 版本 / 帮助 |

环境变量：`APIMCP_DATA_ROOT`（等同 `--data-root`，旧名 `APIPOST_DATA_ROOT` 仍可用）、`APIMCP_HOME`、`APIMCP_CONFIG`

AI 相关配置不在命令行里，统一在控制台「外观设置 → AI 设置」维护，写入 `config.json` 的 `ai` 字段。

## 常见问题

**双击后没反应 / 一闪而过**
检查 39100 端口是否已被占用：`netstat -ano | findstr :39100`。被同款服务占着属正常（可继续用那个），被别的程序占了就换端口启动。

**浏览器打开后提示没有 token / 打不开控制台**
控制台地址必须带着 `?ui=<token>`。地址在 exe 启动时的终端输出里，也能在 `%APPDATA%\\ApiMCP\config.json` 的 `ui_token` 字段找到。

**控制台显示「数据目录不可用」**
说明目录无法创建或没有写权限。在「外观设置 → 数据目录」里换一个可写目录，或用 `--data-root "D:\..."` 指定后重启。

**请求体是一整行，看着难受**
请求体编辑器上方有「美化 / 压缩」按钮，能把单行 JSON 转成缩进多行（XML/HTML 则是「格式化 XML」）。所有 JSON 编辑区（Body、响应示例、Mock schema、用例输入）都有这个工具条。

**改了设计页的示例值，调试页发出去的请求怎么没变**
这是刻意设计。设计页的「示例值」存在 `example_value`，调试页实际发送用 `value`，两者互不影响。要改实际发送的值，请到调试页对应页签改。

**Cookie 页签填了但请求里没有**
检查 Header 里是否也有一条 `Cookie`。执行层只在没有 `Cookie` 请求头时才用 Cookie 表，同时存在时以 Header 为准。Cookie 页签顶部会显示黄条提示，可点「删掉 Header Cookie」或「迁到 Cookie 表」。

**断言没生效 / 校验结果和以前不一样**
旧接口的 `response.is_check_result` 结构校验默认仍生效，可视化断言是另一套机制。两者可以并存，但校验规则会分散在两处。想统一到断言表，请到「后执行操作」点「迁移为断言」。

**响应耗时只有总数，看不到 DNS / TLS 各段**
分阶段耗时只对 HTTP/1.1 采集。把接口协议切到 `http/1.1` 再发一次；HTTP/2 与历史记录只有总耗时。

**删掉了默认项目，重启后还会再出现吗**
不会。默认项目只在数据目录**首次初始化**时播种一次；之后即使把项目全部删光，重启也不会再自动创建。需要时在「总览」点「新建项目」即可。

**升级到 2.0 后工具名变了**
工具的调用名由 `apipost_*` 改为 `apimcp_*`（服务名 `apimcp` 不变，`mcp.json` 无需修改）。写死了旧工具名的提示词或自建脚本需要跟着改。

**升级到 2.0 后看不到旧数据**
2.0 起数据目录改为 `%APPDATA%\ApiMCP\data\`，不再读写 `%APPDATA%\Apipost单机版\`，也不做自动迁移。如需沿用旧数据，用 `--data-root` 指过去，或把旧目录里的 `offline-projects.json`、`offline-data\`、`offline-data-local\` 拷进新目录。

**关了 exe 黑框，服务就没了**
`apimcp.exe` 是前台进程，关掉即停服务。想常驻，把快捷方式丢进 `shell:startup`（Win+R 输入）并把「运行方式」设为最小化。

**桌面端只拷了 exe，打不开**
必须整个 `ApiMCP-Desktop-win32-x64` 目录一起拷，Electron 运行时在同目录的 dll 和 `locales/` 里。

**配到 Cursor 后工具调不通**
`mcp.json` 里的 `command` 必须是 exe 的**绝对路径**；改完要重启 Cursor。可先用控制台「客户端配置」页面复制，避免手写出错。

**改了 `web/` 下的文件，但页面还是旧的**
控制台资源是内联进 exe 的。开发时跑 `node src/main.js --serve` 会用最新文件；但如果用的是打包好的 exe，必须先 `npm run build`（或至少 `node scripts/gen-assets.mjs`）。

**AI 功能点了没反应 / 提示未启用**
到「外观设置 → AI 设置」勾选启用并填好 API 地址、模型与 API Key，再用「测试连通性」确认。地址要带版本路径，例如 `https://api.deepseek.com/v1`（不是 `.../chat/completions`，程序会自动拼）。

**AI 报 401 / 429 / 超时**
401 是 Key 不对或没有该模型权限；429 是限流或余额不足；超时可在配置里调大 `timeout_ms`（程序内限制 5s ~ 300s）。错误信息里不会出现你的 Key。

**自动化计划里的步骤改了接口却没生效**
执行计划的步骤保存时会固化一份接口快照，这是刻意设计——避免改接口把所有历史计划的预期结果打乱。要让步骤用最新定义，删掉该步骤重新添加即可。

**循环控制器把程序跑死了**
While 控制器有 `max_iterations` 上限（默认 100，最大 1000），达到上限会强制退出并在报告里提示。如果是次数控制器，`times` 上限同样是 1000。

## 桌面端（Electron 独立窗口）

`apimcp.exe` 走系统浏览器；如果不想在浏览器标签页里操作控制台，用桌面端：

```powershell
npm run build
npm run build:desktop
# 产物：dist/desktop/ApiMCP-Desktop-win32-x64/ 与同名 .zip
```

分发时把 zip 直接发出去，或**整个目录一起拷贝**（Electron 运行时依赖同目录下的 dll、locales 等，目录内已含 `apimcp.exe`）。

| 特性 | 说明 |
|---|---|
| 外观 | 无地址栏/标签页，顶栏即标题栏，右上角为原生窗口按钮 |
| 主题 | 标题栏配色跟随控制台的暖纸金/暗色/自定义主题 |
| 服务 | 服务跑在桌面端进程内；也可附着到已运行的 `apimcp.exe` |
| 单实例 | 重复双击只聚焦已有窗口 |
| 记忆 | 窗口尺寸/位置/最大化状态存在 `%APPDATA%\\ApiMCP\desktop-window.json` |
| 外链 | 站外链接交给系统浏览器，页面内不允许任意导航 |
| 选文件 | Body 的 `binary` 模式可直接弹原生文件选择框 |

桌面端与 SEA 单文件版的启动关系：

```mermaid
flowchart TD
  Desktop[双击 Desktop.exe] --> Listen{39100 端口空闲?}
  Listen -->|是| Owned["owned：桌面端自己起服务<br/>关窗口即停服务"]
  Listen -->|否| Probe{"同款服务 + ui_token 校验"}
  Probe -->|通过| Attached["attached：只开窗口<br/>关窗口不影响对方服务"]
  Probe -->|"ui_token 或数据目录不一致"| Conflict["弹窗：端口被其它程序占用"]
```

开发调试：`set APIPOST_MCP_DEV=1` 后可开 F12 / Ctrl+Shift+I 开发者工具；`npm run dev:desktop` 免打包直接跑。

## 数据流

```mermaid
flowchart LR
  Agent[AI 客户端] -->|stdio / HTTP| Core[核心服务]
  UI[Web 控制台] --> Core
  Core -->|直接读写| Data[(本地数据<br/>%APPDATA%/ApiMCP/data)]
```

控制台与 MCP 工具读写同一份本地数据，没有中间工作区，也没有拉取 / 推送步骤。

## 目录结构

```
src/
  main.js              CLI 入口（SEA 单文件版）
  version.js           版本号单一来源
  desktop/             桌面端（Electron 主进程 / preload / 服务附着 / 窗口状态）
  store/               数据读写（paths/projects/apis/envs/flows/flows-nodes/runs/recent/target）
  exec/                执行引擎（http/auth/template/assert/script/runner/stress）
                       ├─ timed-request.js   8 段耗时传输层（node:http(s)）
                       └─ assert-visual.js   可视化断言（12 数据源 × 15 条件）
  mcp/                 工具定义（schemas/tools）、协议（protocol）、stdio
  openapi/convert.js   OpenAPI 3.0/3.1 转换
  server/              HTTP 服务、配置、客户端配置生成、AI 客户端（ai.js）、Mock 服务
web/                   控制台
  ├─ index.html        页面骨架与脚本顺序
  ├─ app.js            整体状态、侧栏、总览、客户端配置
  ├─ design.js         接口设计：树、设计页契约视图、批量编辑、右键菜单、多标签页
  ├─ workspace.js      调试页工作区：上下分栏、8 请求页签、6 响应页签、耗时明细
  ├─ envvars.js        环境与变量
  ├─ extra.js          接口用例 / 一键压测 / Mock 面板
  ├─ automation.js     自动化测试编排与报告
  ├─ transfer.js       导入导出页
  ├─ recent.js         最近
  ├─ codegen.js        代码生成（六种语言）
  ├─ curl-parse.js     cURL 解析（三种方言）
  ├─ curl-build.js     cURL 生成
  ├─ style.css         组件样式
  └─ theme.css         主题变量
build/                 gen-icon.mjs 生成的 icon.ico（9 档多尺寸）/ icon.png
test/                  node:test 测试
scripts/               gen-assets.mjs / gen-icon.mjs / build.mjs / build-desktop.mjs
```

`src/store/flow-nodes.js` 定义执行计划的节点模型（接口步骤 + 五种控制器）与规范化校验；`src/server/ai.js` 封装 OpenAI 兼容客户端与三个 AI 能力。

`web/` 下的脚本按 `index.html` 的顺序加载，全部通过 `window.*` 桥接互相调用（`ApiDesign` / `ApiWorkspace` / `ApiExtra` 等），没有构建步骤。

## 测试

```powershell
npm test
```

当前 354 项测试。

覆盖：数据根解析与首次初始化播种（含幂等与优先级）、模板变量优先级、鉴权构造、schema 校验、OpenAPI 转换、本地数据目录读写（含越界保护）、存储 CRUD、执行引擎（含脚本沙箱、跨步骤传值、步骤快照固化）、MCP 协议与 34 工具名一致性、HTTP 服务鉴权与新建项目接口、接口编辑器 CRUD（含级联删除与落盘验证）、桌面端服务附着（含数据目录同源校验）与窗口状态、设计 / 用例 / Mock 三个数据域的脏标记隔离（`preserve_aux`）、调试详情（`live_detail`）、用例响应头 / Content-Type 校验、压测进度时间线、Mock 自定义响应头、图标 ICO 结构。

新增覆盖：代码生成六种语言的产出与转义、文档导出三种格式与空壳示例过滤、`/doc` 只读文档页鉴权、控制器节点模型与向后兼容、条件分支与 else 分支、次数循环、While 上限保护、等待与脚本控制器、`stop_on_fail` 中止、报告树与计划结构同构、AI 配置不泄漏 Key、OpenAI 兼容客户端（含 401 / 429 / 超时 / 非 JSON 响应）、三个 AI 端点在未配置时的明确报错。

最近新增：

- **分阶段耗时**（`test/timed-request.test.mjs`，13 项）— 8 段字段齐全且非负、302/307 跳转语义、gzip/deflate 解压、多 `Set-Cookie` 收集、`asFetchLike` 的 fetch 兼容接口、连接失败带 `networkStage`
- **可视化断言**（`test/assert-visual.test.mjs`，48 项）— JSONPath 各种写法、XML 路径、12 数据源、15 条件、`schema_match` 复用 `validateSchema`
- **断言接线与耗时透出**（`test/send.test.mjs` 追加 6 项）— 断言通过 / 失败 / 禁用、与自定义脚本共存、旧 `is_check_result` 路径不变、`timings` 贯穿到落盘记录
- **`example_value` 导出兜底**（`test/docexport.test.mjs` 追加 2 项）— 老数据回落 `value`、新数据优先 `example_value`

## 控制台

| 菜单 | 功能 |
|---|---|
| 总览 | 服务状态、Token、数据目录、项目授权、新建项目、快速开始 |
| 环境与变量 | 三个页签：环境（多环境 + 环境变量 + 多 host 服务）、全局参数（含目录参数继承）、全局变量；每个页签底部含可折叠的使用说明 |
| 接口设计 | 接口树 + 顶部多标签页 + 五个模式页签（设计 / 调试 / 接口用例 / 一键压测 / Mock）。设计页是契约视图；调试页上下分栏，含 8 个请求页签与 6 个响应页签；目录有「目录设置 / 目录参数 / 接口列表」三个子页签 |
| 自动化测试 | 执行计划列表 + 步骤树编排（接口步骤与五种控制器嵌套）+ 可视化执行报告 |
| 导入导出 | 导入 OpenAPI 3.x / Swagger 2.0 / Postman v2.1 / HAR / cURL / AI 解析（先预览再落库，可选目标目录与覆盖方式）；导出 OpenAPI（JSON / YAML）/ Postman v2.1 / Markdown / HTML / Word，并可打开只读文档页 |
| 客户端配置 | Cursor / Claude Code / VS Code / Trae / Codex 配置一键复制 |
| 工具清单 | 34 个 MCP 工具说明 |
| 外观设置 | 暖纸金 / 暗色 / 自定义底色 + 字号缩放 + 数据目录 + AI 设置 |
| 关于 | 版本与路径信息 |

「接口设计」的编辑直接写入本地数据目录，保存即时生效。

五个模式页签各自独立：设计保存只提交设计字段（不会覆盖用例与 Mock），用例与 Mock 页签各有自己的「未保存」标记与 Ctrl+S，压测与 Mock 页签的请求栏只读。

顶部标签栏支持同时打开多个接口（上限 12 个），每个标签页保留自己的未保存草稿与所处模式；切换项目时清空，因为标签页只在当前项目内有效。

「调试」页展示实际发出的完整请求头、Query、请求体、状态行、响应头、逐条 `Set-Cookie` 与实际 URL，并支持「隐藏敏感值」开关、「复制为 cURL」与「生成代码」（六种语言）。这些详情只在本机即时返回，落盘的执行历史仍按 `authorization / cookie / token` 等敏感键打码。

### 请求失败时

DNS 失败、连接超时、证书错误等拿不到响应的情况，响应区不再摆出一堆空页签，只显示三样东西：

- 错误信息（例如 `请求失败：... (ENOTFOUND: ...) — https://xxx`）
- 折叠的「发送日志」（有内容时才出现，含未解析变量等告警）
- 展开的「实际请求」：真正发出去的方法、URL、请求头、Query 与请求体

对照「实际请求」能直接看出问题，例如请求头里的 `{{uat-api-token}}` 没被环境变量替换掉。变量未解析时会在发送日志里给出 `未解析的变量：uat-api-token（将按字面量发送）`，请求仍照常发出——可能是有意发占位符，所以只告警不拦截。

## 工具清单

| 分类 | 工具 |
|---|---|
| 项目与 API | `list_projects` `create_project` `list_apis` `get_api_detail` `sync_openapi` `delete_apis` |
| 接口执行 | `execute_api` |
| 环境与变量 | `list_environments` `switch_environment` `create_environment` `update_environment` `delete_environment` `list_environment_servers` `create_environment_server` `update_environment_server` `delete_environment_server` `get_environment_variables` `upsert_environment_variable` `delete_environment_variable` `get_global_variables` `upsert_global_variable` `delete_global_variable` `get_global_params` `update_global_params` |
| 执行计划 | `create_execution_flow` `update_execution_flow` `list_execution_flows` `get_execution_flow` `delete_execution_flow` `execute_flow` |
| 执行历史 | `list_execution_runs` `get_execution_result` |
| 导入导出 | `import_project` `export_project` |

## 限制

- 仅支持 HTTP 接口执行（`target_type === 'api'`）；SSE / WebSocket / gRPC / Mock / 数据库请求不在工具范围内。SSE 只有类型定义占位，界面上的「Event Stream」入口置灰
- 鉴权支持 `noauth / basic / bearer / kv(apikey) / oauth2(静态 token) / inherit`；界面上会列出 Digest / AWS Signature / NTLM / OAuth 1.0 / Hawk / EdgeGrid，选中时明确提示「执行层暂不支持」并建议用预执行脚本手工签名
- 全局/目录参数的 Body 只支持 `form-data` 与 `urlencoded`；Header / Query / 鉴权 / 前后置脚本可继承
- Cookie 有两种写法（独立参数表 / Header 的 `Cookie` 键），但执行层只在没有 `Cookie` 请求头时才用参数表，同时存在时以 Header 为准
- 全局参数与目录参数的执行顺序：前置脚本 `全局 → 目录 → 接口`，后置脚本 `接口 → 目录 → 全局`；同名参数内层优先，内层 `is_checked = -1` 表示禁用外层同名项
- 可视化断言的数据源含 `response_xml`，但只支持简单标签路径（`/root/name`），不支持命名空间、属性筛选与同名标签嵌套；复杂场景请用后置脚本
- JSONPath 是精简实现，不支持 `..` 递归下降、过滤器与切片
- `response.is_check_result` 与可视化断言是两套机制，旧接口默认仍走前者；迁移需在「后执行操作」手动点「迁移为断言」
- 代码生成覆盖 cURL / fetch / axios / Python / Go / Java 六种；`form-data` 与 `binary` 模式无法用文本还原，会给出 warning 而不是编造数据
- 分阶段耗时只对 HTTP/1.1 生效；HTTP/2 与显式注入 `fetchImpl` 的场景只有总耗时
- form-data 的「内容类型」列只影响 multipart 分段的 `Content-Type`，`urlencoded` 不使用该列
- 批量编辑的 Raw-Json 格式只接受扁平对象，遇到嵌套结构会明确报错而不会自动拍平
- 顶部多标签页只在当前项目内有效，切换项目会清空；仅存内存，刷新页面后清空
- Word 导出为 `.doc`（HTML 包装），不是 `.docx`；Word / WPS 可直接打开，但部分老版本会提示「格式与扩展名不一致」
- 执行计划目前只由 Web 控制台与 MCP 工具操作；控制器条件使用 JS 表达式，暂不提供可视化条件构建器
- AI 能力需要外网可访问的 OpenAI 兼容服务；本地模型（如 Ollama）也可用，但需自行启动
- 「IDEA 上传」需要配套插件，当前版本置灰并提供原因说明

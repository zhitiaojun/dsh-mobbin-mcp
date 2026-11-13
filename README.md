# dsh-mobbin-mcp

把 [Mobbin](https://mobbin.com) 的 MCP 服务接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
装好之后，可以直接在对话里用自然语言检索 Mobbin 的 App / 网站界面截图，图片会作为图片块进入模型上下文。

Mobbin MCP 只支持 **OAuth 2.0（无 API Key）**，官方客户端文档里的 "Other" 客户端就是自己实现授权流程。本插件用 Node 原生 `fetch` 完成整条链路：

- **受保护资源发现** － `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp`
- **授权服务器元数据** － `/.well-known/oauth-authorization-server`
- **动态客户端注册（RFC 7591）** － 每次授权向 Mobbin 注册一个本机 loopback 客户端
- **PKCE（S256）+ 本地回调服务器** － `http://127.0.0.1:<port>/callback`
- **令牌交换与刷新** － 令牌落盘到 `$DSH_HOME/mobbin-mcp/oauth.json`（权限 0600），过期前 60 秒自动刷新

## 前置条件

- DeepSeek Harness `>= 0.2.0`
- Node.js `>= 20`
- 一个 **Mobbin Pro / Team / Enterprise** 账号（Mobbin MCP 只对付费套餐开放）

## 安装

从 GitHub 装：

```bash
dsh plugin --profile web add github:zhitiaojun/dsh-mobbin-mcp
```

从 npm 装：

```bash
dsh plugin --profile web add dsh-mobbin-mcp
```

本地开发时装当前目录：

```bash
dsh plugin --profile web add .
```

## 授权

首次启动时插件还拿不到令牌，因此只注册两个工具：

- `mcp__mobbin__authorize` —— 启动授权流程，并立刻把授权链接返回给对话（不会卡住）；
- `mcp__mobbin__authorize_status` —— 查询状态：`idle` / `running`（附链接）/ `failed`（附错误）/ `connected`。

在对话里让模型调用 `mcp__mobbin__authorize`（或直接说「登录 Mobbin」），插件会：

1. 在后台起一个 loopback HTTP 服务器接 OAuth 回调，完成动态客户端注册与 PKCE；
2. 返回 Mobbin 授权页 URL —— 打开链接、登录并批准（DSH 服务进程弹出的浏览器窗口不一定会出现在你的桌面上，复制链接手动打开最稳妥）；
3. 批准后回调到达，插件换取令牌、落盘，并把 Mobbin 的真实工具注册进来；
4. 用 `mcp__mobbin__authorize_status` 确认状态变成 `connected`。

连接成功后两个授权工具一起下线，之后每次 DSH 启动都直接从磁盘读令牌、静默连接。

想免去手动触发，可以让插件启动时自己弹浏览器：

```yaml
config:
  autoAuthorize: true
```

也可以脱离 DSH 单独登录（同一份令牌文件，适合排查授权问题）：

```bash
npm run login
```

## 配置

`cordis.patch.yml` 里只有最小配置；其它字段按需补：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `serverName` | `mobbin` | 工具名前缀，最终形如 `mcp__mobbin__search_screens` |
| `url` | `https://api.mobbin.com/mcp` | MCP 端点（Streamable HTTP） |
| `scope` | `openid offline_access` | 授权时申请的 scope；`offline_access` 用来拿 refresh token，避免反复登录 |
| `tokenFile` | `$DSH_HOME/mobbin-mcp/oauth.json` | 令牌文件位置 |
| `callbackPort` | `14565` | 回调端口；被占用时自动改用随机端口 |
| `autoAuthorize` | `false` | 没有令牌时是否启动即拉起浏览器授权 |
| `openBrowser` | `true` | 是否自动打开浏览器 |
| `toolCallTimeoutMs` | `60000` | 单次 Mobbin 工具调用超时 |

## 工具

工具清单由 Mobbin 服务端下发，插件启动后原样注册，命名规则与 DSH 内置 MCP 客户端一致：

- 前缀 `mcp__<serverName>__`
- 只保留 `[A-Za-z0-9_-]`，超长名字截断并附 12 位 SHA-256 摘要后缀

典型能力（以服务端实际下发为准）：自然语言检索界面截图、按 App / 平台 / 界面类型浏览、管理收藏集。

## 图片怎么处理

Mobbin 的工具结果里带内联图片。插件在 `projectContent` 阶段做一次投影：

- 模型支持图片输入（`inputModalities` 含 `image`）且进程里挂了 attachments 存储时，图片解码后存成附件，模型看到的是真正的图片块；
- 否则退化成一行说明文字，原始图片数据仍然留给程序化调用方，不会让整次调用失败。

## 安全

- 令牌只存在本机，文件权限 0600，不会出现在日志里；
- 授权走 PKCE + loopback，插件不收集也不转发用户密码；
- 插件只在启动时连接 Mobbin，不会后台轮询；
- `autoAuthorize` 默认关闭，避免每次启动无预警弹出浏览器。

## 开发

```bash
npm install
npm run check          # 语法检查
node test/naming.test.mjs
node test/plugin.test.mjs
node test/oauth.test.mjs   # 需要联网，MOBBIN_OFFLINE=1 可跳过
npm run login          # 真实 OAuth 授权
```

目录：

```
lib/index.js   cordis 插件入口：Config / apply / authorize 工具
lib/oauth.js   发现、DCR、PKCE、回调服务器、令牌存取与刷新
lib/mobbin.js  MCP 客户端桥接、工具命名、图片投影
```

## 许可

MIT

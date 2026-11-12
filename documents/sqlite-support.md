# SQLite 支持说明

本文集中说明新增的 SQLite 存储能力，避免修改现有 `documents/docs/` 下的公共文档页面。

## 功能与限制

- 支持 **JSON 文件（默认）、SQLite 或 PostgreSQL** 三种存储方式，通过数据库 URL 选择后端，无需额外的数据库类型变量。
- SQLite 无需独立数据库服务，支持常规持久化：服务器、分组、用户、系统 / 个人配置、密钥、OAuth 状态、小智端点及 Better Auth。
- **pgvector 和向量智能路由仍仅支持 PostgreSQL**。SQLite 部署请保持 `SMART_ROUTING_ENABLED=false`，使用普通服务器 / 分组路由；小智端点也不要绑定 `$smart`。
- 原有 PostgreSQL 部署和 `docker-compose.yml` 保持可用。更改 URL 只是切换数据源，**不会自动将现有 PostgreSQL 数据迁移到 SQLite**；升级已有部署请保留原 PostgreSQL URL 和数据卷。

## 本地运行

推荐 **Node.js 22** 和 pnpm。SQLite 使用原生模块 `better-sqlite3`，**不支持 Node.js 18**。仅选择 PostgreSQL 存储或向量智能路由时才需要 PostgreSQL 服务。

在项目根目录运行：

```bash
pnpm install

# SQLite needs no separate database service; these values can also go in .env.
export DB_URL="sqlite:./data/mcphub.sqlite"
export SMART_ROUTING_ENABLED="false"

# Start backend (:3000) and frontend (Vite :5173).
pnpm dev
```

访问前端开发服务器 `http://localhost:5173`，其 API 请求会代理到后端 `:3000`。生产运行可执行 `pnpm build` 后再执行 `pnpm start`，并设置强随机 `JWT_SECRET`。

开发环境读取项目根目录的 `.env`，无需创建 `.env.dev`。其中 `PORT=3000` 控制后端端口，不会把 Vite 的前端端口改成 `3000`；当前开发代理指向后端 `3000`。启动后应同时看到 Vite 的 `5173` 地址和后端的 `Server is running on port 3000` 日志，可访问 `http://localhost:3000/health` 检查后端。仅看到 Vite 启动成功并不代表后端已就绪。

已有用户仍使用原密码，`ADMIN_PASSWORD` 只用于空用户库的首次管理员创建，不会重置已有账号。不要通过删除数据库来处理开发登录问题。

开发启动器优先使用环境变量或项目 `.env` 中的 `JWT_SECRET`。未配置时，每次启动会生成一个随机密钥，在同一次启动器运行期间的后端自动热重启中保持不变。完全停止并重新执行 `pnpm dev` / `pnpm backend:dev` 会生成新密钥；如需跨完整重启保持登录，请配置固定的高强度 `JWT_SECRET`，不要提交真实密钥。SQLite 持久化用户数据不会持久化 JWT 签名密钥。

## 存储配置

| 配置 | 行为 |
|------|------|
| 未配置 `DB_URL` 和旧名 `DATABASE_URL` | 默认使用 JSON 文件模式 |
| `DB_URL` | 优先于旧名 `DATABASE_URL`，根据 URL 选择后端 |
| `DATABASE_URL` | 仅在 `DB_URL` 未配置时作为兼容回退 |
| `USE_DB=false` | 即使配置了 URL，也强制使用 JSON 文件模式 |
| `USE_DB=true` | 强制启用数据库模式，仍需提供有效数据库 URL |
| `sqlite:./data/mcphub.sqlite` | 相对于进程的当前工作目录，而非 `.env` 所在目录 |
| `sqlite:/absolute/path/mcphub.sqlite` | 绝对路径 |
| `sqlite:///absolute/path/mcphub.sqlite` | 绝对路径的另一种写法 |
| `sqlite::memory:` | 临时内存库，连接关闭或进程重启后数据丢失 |

SQLite 文件的父目录会自动创建；运行用户必须有写入数据库及同目录侧文件的权限。持久化部署请使用文件库，不要使用内存库。Better Auth 通过独立连接访问同一个 SQLite 文件；使用 `sqlite::memory:` 时，其认证库与应用内存库独立，且同样是临时的。

## Docker Compose 部署

使用独立的 `docker-compose.sqlite.yml`，无需启动 PostgreSQL 服务：

```bash
docker compose -f docker-compose.sqlite.yml up -d
docker compose -f docker-compose.sqlite.yml logs -f mcphub
```

此配置：

- 设置 `DB_URL=sqlite:/app/data/mcphub.sqlite`。
- 将命名卷 `sqlite-data` 挂载到 `/app/data`，保存数据库及侧文件。
- 设置 `SMART_ROUTING_ENABLED=false`。
- 支持小智端点和 Better Auth 的数据库持久化；第三方登录仍需配置对应提供方。
- 也会包含在 GitHub Release 压缩包中。

生产环境请在 compose 中设置强随机 `JWT_SECRET`。此文件应**单独使用**，不要与 PostgreSQL 的 compose 文件合并；需要 PostgreSQL + pgvector 时，继续使用原有 `docker-compose.yml`。

## 持久化与备份

- 重建容器或执行 `docker compose -f docker-compose.sqlite.yml down` 不会删除命名卷。
- **`docker compose -f docker-compose.sqlite.yml down -v` 会删除数据卷及其中的数据。**
- 简单可靠的备份方式是先停应用，备份整个卷或数据库及可能存在的 `-wal` / `-shm` 侧文件，再启动应用；认证数据也保存在该文件中。

## 小智端点连接状态与诊断

“WebSocket 已连接”仅表示 MCPHub 当前的传输连接，不等同于小智官方确认在线。端点卡片分别显示最近心跳响应、工具列表响应发送时间和最近断开的代码 / 原因；工具列表成功写入套接字也不代表官方已接收或接受。官方旧页面可能未自动刷新，可重新打开 MCP 接入点面板核对。

服务每 30 秒发送 WebSocket 控制帧 ping，10 秒内未收到 pong 会立即标记断开、终止旧连接并按重连配置重试。收到 close / error 时立即更新内存状态，不等待数据库写入；上次 close 的时间、代码和原因会保留到重连后（进程重启后不保留）。例如 `1009` 通常表示对端拒绝过大的消息，可缩小绑定分组的工具列表。

端点页每 5 秒获取一次实时状态。请求失败或状态超过 15 秒未更新时，清除旧的“已连接”快照并显示未知 / 重试提示，而不是继续显示在线。状态接口禁止缓存。

## Better Auth

Better Auth 支持 SQLite 或 PostgreSQL 数据库模式。启用数据库模式并配置 `DB_URL`；兼容旧名 `DATABASE_URL`，但不能设置 `USE_DB=false`。SQLite 文件模式下，Better Auth 用户、会话及账号等认证表使用独立连接，写入与应用相同的 SQLite 文件；备份该文件时也应包含认证数据。SQLite 不要求 pgvector，只有向量智能路由仍需 PostgreSQL + pgvector。

## 智能路由

SQLite 部署不支持 pgvector / 智能路由向量检索。SQLite 仍支持常规持久化、小智端点和 Better Auth，但应保持 `SMART_ROUTING_ENABLED=false`，也不要在用户设置或小智端点上开启智能路由。客户端使用 `/mcp`、`/mcp/{group}` 或 `/mcp/{server}` 等普通路由，而不是 `$smart`。需要此功能时请使用 PostgreSQL + pgvector 部署；仅填写 API Key 不能让 SQLite 支持向量检索。

## 相关文档

- [环境变量](docs/configuration/environment-variables.md)
- [Docker 部署](docs/configuration/docker-setup.md)
- [MCP 设置](docs/configuration/mcp-settings.md)
- [小智端点](docs/configuration/xiaozhi.md)
- [认证说明](docs/features/authentication.md)
- [智能路由](docs/features/smart-routing.md)

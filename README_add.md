# 新增功能

Add SQLite database support.

## 中文：SQLite 支持说明

本文件汇总新增 SQLite 功能的使用说明，原有 `README.md` 和 `README.zh.md` 保持不变。

### 功能与限制

- 支持 **JSON 文件（默认）、SQLite 或 PostgreSQL** 三种存储方式，通过数据库 URL 选择后端，无需额外的数据库类型变量。
- SQLite 无需独立数据库服务，支持常规持久化：服务器、分组、用户、系统 / 个人配置、密钥、OAuth 状态、小智端点及 Better Auth。
- **pgvector 和向量智能路由仍仅支持 PostgreSQL**。SQLite 部署请保持 `SMART_ROUTING_ENABLED=false`，使用普通服务器 / 分组路由；小智端点也不要绑定 `$smart`。
- 原有 PostgreSQL 部署和 `docker-compose.yml` 保持可用。更改 URL 只是切换数据源，**不会自动将现有 PostgreSQL 数据迁移到 SQLite**；升级已有部署请保留原 PostgreSQL URL 和数据卷。

### 本地运行

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

### 存储配置

| 配置                                      | 行为                                             |
| ----------------------------------------- | ------------------------------------------------ |
| 未配置 `DB_URL` 和旧名 `DATABASE_URL` | 默认使用 JSON 文件模式                           |
| `DB_URL`                                | 优先于旧名 `DATABASE_URL`，根据 URL 选择后端   |
| `DATABASE_URL`                          | 仅在 `DB_URL` 未配置时作为兼容回退             |
| `USE_DB=false`                          | 即使配置了 URL，也强制使用 JSON 文件模式         |
| `USE_DB=true`                           | 强制启用数据库模式，仍需提供有效数据库 URL       |
| `sqlite:./data/mcphub.sqlite`           | 相对于进程的当前工作目录，而非 `.env` 所在目录 |
| `sqlite:/absolute/path/mcphub.sqlite`   | 绝对路径                                         |
| `sqlite:///absolute/path/mcphub.sqlite` | 绝对路径的另一种写法                             |
| `sqlite::memory:`                       | 临时内存库，连接关闭或进程重启后数据丢失         |

SQLite 文件的父目录会自动创建；运行用户必须有写入数据库及同目录侧文件的权限。持久化部署请使用文件库，不要使用内存库。Better Auth 通过独立连接访问同一个 SQLite 文件；使用 `sqlite::memory:` 时，其认证库与应用内存库独立，且同样是临时的。

### Docker Compose 部署

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

### 持久化与备份

- 重建容器或执行 `docker compose -f docker-compose.sqlite.yml down` 不会删除命名卷。
- **`docker compose -f docker-compose.sqlite.yml down -v` 会删除数据卷及其中的数据。**
- 简单可靠的备份方式是先停应用，备份整个卷或数据库及可能存在的 `-wal` / `-shm` 侧文件，再启动应用；认证数据也保存在该文件中。

更多配置见[环境变量](documents/docs/configuration/environment-variables.md)、[Docker 部署](documents/docs/configuration/docker-setup.md)和[认证说明](documents/docs/features/authentication.md)。

## 小智 mcp 接入点文档

接入点文档：https://my.feishu.cn/wiki/HiPEwZ37XiitnwktX13cEM5KnSb

## English: SQLite Support

This file consolidates the new SQLite documentation while leaving `README.md` and `README.zh.md` unchanged.

### Features and limitations

- Storage supports **JSON files (default), SQLite, or PostgreSQL**. The database URL selects the backend; no separate database-type variable is needed.
- SQLite needs no separate database service. It supports normal persistence: servers, groups, users, system / user settings, keys, OAuth state, Xiaozhi endpoints, and Better Auth.
- **pgvector and vector-based smart routing remain PostgreSQL-only**. Keep `SMART_ROUTING_ENABLED=false` on SQLite and use normal server / group routes. Xiaozhi endpoints should not bind to `$smart` on SQLite.
- Existing PostgreSQL deployments and `docker-compose.yml` remain available. Changing the URL selects a different store; it **does not automatically migrate an existing PostgreSQL database into SQLite**. Keep existing PostgreSQL URLs and volumes when upgrading those deployments.

### Local development

Use **Node.js 22 (recommended)** and pnpm. SQLite uses native `better-sqlite3` and **does not support Node.js 18**. A PostgreSQL server is only needed for PostgreSQL storage or vector smart routing.

Run from the project root:

```bash
pnpm install

# SQLite needs no separate database service; these values can also go in .env.
export DB_URL="sqlite:./data/mcphub.sqlite"
export SMART_ROUTING_ENABLED="false"

# Start backend (:3000) and frontend (Vite :5173).
pnpm dev
```

Open `http://localhost:5173`; the frontend development server proxies API requests to backend `:3000`. For production, run `pnpm build` followed by `pnpm start`, and set a strong random `JWT_SECRET`.

Development reads `.env` from the project root; no `.env.dev` is needed. `PORT=3000` configures the backend, not Vite's frontend port; the current development proxy targets backend port `3000`. Look for both Vite's `5173` URL and the backend's `Server is running on port 3000` log, and check `http://localhost:3000/health`. A ready Vite server alone does not mean the backend is ready.

Existing users keep their passwords. `ADMIN_PASSWORD` only creates the initial administrator when the user store is empty; it does not reset an existing account. Do not delete the database to troubleshoot development login.

The development launcher prefers `JWT_SECRET` from the environment or the project `.env` file. When it is not configured, each launcher run generates a random secret and reuses it across backend hot restarts within that run. Fully stopping and starting `pnpm dev` / `pnpm backend:dev` creates a new secret; set a fixed, strong `JWT_SECRET` to preserve sessions across full restarts, and never commit a real secret. SQLite-persisted users do not persist the JWT signing secret.

### Storage configuration

| Configuration                                                | Behavior                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Neither `DB_URL` nor legacy `DATABASE_URL` is configured | JSON-file mode by default                                                     |
| `DB_URL`                                                   | Takes priority over legacy `DATABASE_URL`; its URL selects the backend      |
| `DATABASE_URL`                                             | Backward-compatible fallback when `DB_URL` is not configured                |
| `USE_DB=false`                                             | Forces JSON-file mode even if a database URL is present                       |
| `USE_DB=true`                                              | Forces database mode; a valid database URL is still required                  |
| `sqlite:./data/mcphub.sqlite`                              | Relative to the process's current working directory, not the `.env` file    |
| `sqlite:/absolute/path/mcphub.sqlite`                      | Absolute path                                                                 |
| `sqlite:///absolute/path/mcphub.sqlite`                    | Alternative absolute-path form                                                |
| `sqlite::memory:`                                          | Ephemeral; data disappears when the connection closes or the process restarts |

The parent directory is created automatically. The application must be able to write the database and sidecar files in that directory. Use a file-backed database for deployments, not an in-memory database. Better Auth uses a separate connection to the same SQLite file; with `sqlite::memory:`, its auth database is separate from the application's in-memory database and is also ephemeral.

### Docker Compose deployment

Use the standalone `docker-compose.sqlite.yml` without a PostgreSQL service:

```bash
docker compose -f docker-compose.sqlite.yml up -d
docker compose -f docker-compose.sqlite.yml logs -f mcphub
```

This recipe:

- Sets `DB_URL=sqlite:/app/data/mcphub.sqlite`.
- Mounts the named volume `sqlite-data` at `/app/data` for the database and sidecar files.
- Sets `SMART_ROUTING_ENABLED=false`.
- Supports database persistence for Xiaozhi endpoints and Better Auth; social login still needs the corresponding provider configuration.
- Is also included in GitHub Release archives.

Set a strong random `JWT_SECRET` in the compose file for production. Use this file **on its own**, not merged with the PostgreSQL compose file. Continue using the existing `docker-compose.yml` for PostgreSQL + pgvector.

### Persistence and backups

- The named volume survives container recreation and `docker compose -f docker-compose.sqlite.yml down`.
- **`docker compose -f docker-compose.sqlite.yml down -v` deletes the volume and its data.**
- For a simple consistent backup, stop the app, back up the entire volume or the database together with any `-wal` / `-shm` sidecars, then restart the app. The database file also contains auth data.

See [environment variables](documents/docs/configuration/environment-variables.md), [Docker deployment](documents/docs/configuration/docker-setup.md), and [authentication](documents/docs/features/authentication.md) for more details.

# 开发说明

本文面向后续开发和维护。

## 技术栈

后端：

- Python 标准库。
- `http.server` 提供 HTTP 服务。
- `sqlite3` 保存用户、会话、设置、导航卡片、容器偏好。
- 通过 Unix socket 调用 Docker Engine API。
- 通过 Docker CLI 执行 Compose 和镜像更新相关动作。

前端：

- 原生 HTML。
- 原生 CSS。
- 原生 JavaScript。
- 无打包步骤。

容器镜像：

- 基础镜像 `python:3.13-slim`。
- 从 `docker:28-cli` 复制 Docker CLI 和 Compose 插件。

## 目录说明

```text
dockpilot/server.py       # 后端主程序和 API
web/index.html            # 前端入口
web/app.js                # 前端状态、渲染和交互
web/styles.css            # 样式和响应式布局
scripts/start_local.sh    # 本机启动
scripts/stop_local.sh     # 本机停止
scripts/status_local.sh   # 本机状态
scripts/smoke_test.py     # 冒烟测试
Dockerfile                # 镜像构建
docker-compose.yml        # 源码构建部署
docker-compose.image.yml  # 拉取镜像部署模板
```

## 后端启动流程

1. 读取环境变量。
2. 初始化数据目录。
3. 初始化 SQLite 表。
4. 启动 `ThreadingHTTPServer`。
5. 静态文件由 `web/` 目录直接提供。
6. `/api/*` 请求进入对应 API 处理函数。

默认数据目录：

```text
./data
```

可通过环境变量覆盖：

```bash
DOCKPILOT_DATA=/volume1/docker/dockpilot/data
```

## 数据库表

主要表：

- `users`：管理员账号。
- `sessions`：登录会话。
- `settings`：系统设置。
- `cards`：首页导航卡片。
- `container_prefs`：容器颜色、图标、更新标记。

## Docker 管理方式

容器列表、详情、启停、日志等优先使用 Docker Engine API。

Compose、镜像拉取、更新检测使用 Docker CLI：

```bash
docker compose ...
docker pull ...
docker image inspect ...
```

服务会设置：

```text
DOCKER_HOST=unix:///var/run/docker.sock
```

## 更新检测逻辑

检查更新时会：

1. 读取容器当前 `Image` ID。
2. 执行 `docker pull 镜像名`。
3. 执行 `docker image inspect 镜像名 --format {{.Id}}`。
4. 对比容器当前镜像 ID 和最新本地镜像 ID。
5. 不同则标记为有更新。

## 一键更新逻辑

一键更新会：

1. 创建容器备份。
2. 如果容器带 Compose 标签，执行 Compose 更新。
3. 如果不是 Compose 容器，尝试按 inspect 配置重建。
4. 更新成功后清除 `update_available` 标记。

普通容器重建是尽力而为，复杂参数可能无法完整还原，所以更新前会自动备份。

## 命令转 Compose

入口：

```text
POST /api/compose/from-command
```

当前支持常见 `docker run` 参数，解析逻辑在：

```text
compose_from_docker_run()
```

新增参数支持时，优先在这个函数中添加明确解析规则。

## 本地开发

启动：

```bash
scripts/start_local.sh
```

修改前端文件后刷新浏览器即可。

修改后端文件后需要重启：

```bash
scripts/stop_local.sh
scripts/start_local.sh
```

## 测试

语法检查：

```bash
python3 -m py_compile dockpilot/server.py scripts/smoke_test.py
node --check web/app.js
```

冒烟测试：

```bash
python3 scripts/smoke_test.py
```

冒烟测试覆盖：

- 初始化管理员。
- 登录会话。
- 前端资源加载。
- 导航卡片。
- Compose 项目和命令转换。
- 文件管理。
- 修改密码。
- Docker 不可用时的错误处理。
- 容器偏好和图标保存。
- 容器备份列表。

## 发版

推送到 GitHub 后，GitHub Actions 会构建并推送镜像到 GHCR。

镜像：

```text
ghcr.io/lazycataa/dockpilot:latest
ghcr.io/lazycataa/dockpilot:sha-提交短哈希
```

查看构建：

```bash
gh run list --repo LazyCatAA/dockpilot --limit 5
```

查看镜像标签：

```bash
gh api /users/LazyCatAA/packages/container/dockpilot/versions
```

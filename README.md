# DockPilot

DockPilot 是一个私有 Docker/NAS 管理面板。第一版优先保证稳定可用，先覆盖本机容器管理、Compose 管理、首页导航卡片和基础文件管理。

当前版本没有前端构建步骤，也没有额外 Python 依赖。只需要 Python 3.11+，容器操作通过 Docker Unix socket 完成。

## 已实现功能

- 首次启动创建管理员账号，之后使用 Cookie 会话登录。
- 本机 Docker 容器列表、启动、停止、重启、日志查看。
- 容器详情查看，包括状态、启动时间、重启策略、网络、挂载目录和环境变量。
- 容器管理页面按卡片化布局展示总数、运行中、已停止和有更新数量，统计项可点击筛选。
- 容器卡片支持 6MB 自定义图标上传、状态圆点、镜像更新检查标记和一键更新。
- 容器备份保存 inspect 配置和可恢复的 Compose 文件，恢复时创建新的 Compose 项目。
- 在配置目录中发现 Compose 项目，并在项目列表显示服务/容器状态。
- Compose 文件在线编辑，并支持部署、停止、重启、拉取、检查配置、查看日志。
- 支持粘贴 `docker run` 命令转换为 Compose 项目，也可以直接转 Compose 并部署。
- 桌面端菜单保持左侧显示并支持隐藏，手机端自动切换为底部导航。
- 首页导航卡片，用来放常用服务入口，支持新增、编辑和删除。
- 文件根目录管理，支持浏览、编辑、上传、下载、复制、移动、重命名、删除和新建目录。
- 当前管理员可在设置页修改密码。
- SQLite 保存用户、会话、导航卡片和系统设置。

## 本地运行

```bash
python3 -m dockpilot.server --host 127.0.0.1 --port 8088
```

也可以使用已经准备好的本机部署脚本：

```bash
scripts/start_local.sh
scripts/status_local.sh
scripts/stop_local.sh
```

打开浏览器访问：

```text
http://127.0.0.1:8088
```

第一次访问会进入管理员创建页面。

## 使用 Docker Compose 部署

本地或 NAS 有源码时，可以直接构建部署：

```bash
docker compose up -d --build
```

部署后访问：

```text
http://服务器IP:8088
```

内置的 `docker-compose.yml` 会挂载：

- `./data`：持久化数据目录。
- `/var/run/docker.sock`：让面板管理本机 Docker。
- `./data/stacks`：默认 Compose 项目目录。
- `./data/files`：默认文件管理目录。

## NAS 拉镜像部署

如果代码已经推到 GitHub，并且 GitHub Actions 构建出了镜像，可以在 NAS 上只放两个文件：

- `docker-compose.image.yml`
- `.env`

`.env` 示例：

```env
DOCKPILOT_IMAGE=ghcr.io/你的github用户名/dockpilot:latest
DOCKPILOT_HOST_PATH=/volume1/docker/dockpilot
DOCKPILOT_PORT=8088
```

然后在 NAS 上执行：

```bash
mkdir -p /volume1/docker/dockpilot
cd /volume1/docker/dockpilot
docker compose -f docker-compose.image.yml up -d
```

关键点：

- `DOCKPILOT_HOST_PATH` 必须是 NAS 上的真实绝对路径。
- Compose 文件会把 `${DOCKPILOT_HOST_PATH}/data` 以同样路径映射进容器。
- 这样面板容器内执行 `docker compose` 时，路径和宿主机路径一致，避免容器路径映射错位。
- 如果要让文件管理器管理 NAS 上已有目录，例如 `/volume1/docker`，需要在 `docker-compose.image.yml` 里额外挂载：

```yaml
volumes:
  - /volume1/docker:/volume1/docker
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCKPILOT_HOST` | `0.0.0.0` | 监听地址 |
| `DOCKPILOT_PORT` | `8088` | 监听端口 |
| `DOCKPILOT_DATA` | `./data` | 数据库和默认目录 |
| `DOCKPILOT_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket 路径 |

## 注意事项

- Compose 操作需要运行环境里有 `docker` 命令和 Compose v2 插件。
- 容器启停和日志读取通过 Docker Engine API 直接访问 socket。
- 文件管理接口会限制访问范围，不能越过配置的根目录。
- 远程 Agent、网页终端、Bot 通知和多角色权限放在下一阶段实现。

## 本地测试

运行完整冒烟测试：

```bash
python3 scripts/smoke_test.py
```

这个脚本会自动启动一个临时 DockPilot 服务，使用临时数据目录，不会影响正在运行的 `8088` 服务和已有数据。测试内容包括：

- 首次管理员初始化和登录会话。
- 中文前端资源加载。
- 导航卡片新增、编辑、删除。
- Compose 项目创建、读取、保存和 docker run 命令转换。
- 文件写入、读取、复制、移动和删除。
- 修改密码和新旧密码登录验证。
- 无 Docker 环境下返回明确错误；有 Docker 环境下返回容器列表。
- 容器卡片颜色偏好和自定义图标保存。
- 容器备份列表读取。

## 明日验收建议

1. 打开 `http://127.0.0.1:8088`，刷新页面，确认中文界面和布局。
2. 登录后检查左侧菜单：首页导航、容器管理、Compose管理、文件管理、系统设置，并测试菜单隐藏/展开。
3. 在首页新增一个导航卡片，再编辑和删除它。
4. 在文件管理里新建文件、编辑保存、复制、移动、重命名、删除。
5. 在 Compose管理 里新建项目，保存 `compose.yml`，点击“检查”；再粘贴一条 `docker run` 命令测试转 Compose。
6. 在设置页修改密码，并用新密码重新登录。
7. 如果部署到有 Docker 的 NAS，再验收容器列表、详情、日志、启动、停止和重启。
8. 在容器顶部统计条点击总容器、运行中、已停止、有更新，确认能筛选；点击图标上传自定义图标，检查更新，点击“更新”执行一键更新。
9. 创建容器备份，并在“容器备份”区域恢复为 Compose 项目。

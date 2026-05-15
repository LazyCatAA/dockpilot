# 部署指南

本文说明 DockPilot 的本机运行、源码部署、NAS 拉镜像部署、升级和数据备份方式。

## 运行要求

最低要求：

- Python 3.11+，仅本机调试需要。
- Docker Engine，NAS 或服务器部署需要。
- Docker Compose v2，执行 Compose 管理和命令部署需要。
- 可访问 `/var/run/docker.sock`，用于管理宿主机 Docker。

推荐部署位置：

```text
/volume1/docker/dockpilot
```

## 本机运行

适合开发、预览界面和非 Docker 功能测试：

```bash
python3 -m dockpilot.server --host 127.0.0.1 --port 8088
```

也可以使用脚本：

```bash
scripts/start_local.sh
scripts/status_local.sh
scripts/stop_local.sh
```

访问：

```text
http://127.0.0.1:8088
```

## 源码构建部署

适合已经把源码放在 NAS 或服务器上的情况：

```bash
docker compose up -d --build
```

默认端口：

```text
http://服务器IP:8088
```

`docker-compose.yml` 默认挂载：

- `/var/run/docker.sock:/var/run/docker.sock`
- `${PWD}/data:${PWD}/data`

这里有一个关键点：数据目录在宿主机和容器内保持同一路径，避免 DockPilot 在容器里执行 `docker compose` 时，Compose 里的挂载路径被 Docker 宿主机误解。

## NAS 拉镜像部署

推荐 NAS 使用这种方式。

创建目录：

```bash
mkdir -p /volume1/docker/dockpilot
cd /volume1/docker/dockpilot
```

如果已经下载了本项目，可以直接复制：

```bash
cp docker-compose.image.yml /volume1/docker/dockpilot/docker-compose.yml
cp .env.example /volume1/docker/dockpilot/.env
```

准备 `.env`：

```env
DOCKPILOT_IMAGE=ghcr.io/lazycataa/dockpilot:latest
DOCKPILOT_HOST_PATH=/volume1/docker/dockpilot
DOCKPILOT_PORT=8088
```

准备 `docker-compose.yml`：

```yaml
services:
  dockpilot:
    image: ${DOCKPILOT_IMAGE}
    container_name: dockpilot
    restart: unless-stopped
    ports:
      - "${DOCKPILOT_PORT:-8088}:8088"
    environment:
      DOCKPILOT_DATA: ${DOCKPILOT_HOST_PATH}/data
      DOCKPILOT_DOCKER_SOCKET: /var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DOCKPILOT_HOST_PATH}/data:${DOCKPILOT_HOST_PATH}/data
      - /volume1/docker:/volume1/docker
```

启动：

```bash
docker compose up -d
```

查看状态：

```bash
docker compose ps
docker logs -f dockpilot
```

## 群晖 DSM 注意事项

如果使用群晖 Container Manager：

- 映像填写 `ghcr.io/lazycataa/dockpilot:latest`。
- 端口映射 `8088 -> 8088`。
- 挂载 `/var/run/docker.sock` 到 `/var/run/docker.sock`。
- 挂载 `/volume1/docker/dockpilot/data` 到 `/volume1/docker/dockpilot/data`。
- 环境变量 `DOCKPILOT_DATA=/volume1/docker/dockpilot/data`。

如果还想让文件管理器访问已有 Docker 目录，需要额外挂载：

```text
/volume1/docker -> /volume1/docker
```

## 升级

拉取最新镜像：

```bash
cd /volume1/docker/dockpilot
docker compose pull
docker compose up -d
```

固定版本升级：

```env
DOCKPILOT_IMAGE=ghcr.io/lazycataa/dockpilot:sha-提交短哈希
```

然后执行：

```bash
docker compose pull
docker compose up -d
```

## 数据备份

需要备份的核心目录：

```text
/volume1/docker/dockpilot/data
```

其中包含：

- `dockpilot.db`：用户、会话、设置、导航卡片、容器偏好。
- `stacks/`：默认 Compose 项目目录。
- `files/`：默认文件管理目录。
- `backups/containers/`：容器备份文件。

备份示例：

```bash
tar -czf dockpilot-data-$(date +%F).tar.gz /volume1/docker/dockpilot/data
```

## 恢复

停止容器：

```bash
docker compose down
```

恢复数据目录后启动：

```bash
docker compose up -d
```

如果恢复到另一台 NAS，注意 `.env` 中的 `DOCKPILOT_HOST_PATH` 必须改成新 NAS 的真实绝对路径。

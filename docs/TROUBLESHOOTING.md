# 故障排查

本文记录 DockPilot 常见问题和处理方式。

## 页面打不开

先检查容器是否运行：

```bash
docker ps | grep dockpilot
```

查看日志：

```bash
docker logs -f dockpilot
```

确认端口：

```bash
docker compose ps
```

如果端口冲突，修改 `.env`：

```env
DOCKPILOT_PORT=18088
```

然后重启：

```bash
docker compose up -d
```

## 提示找不到 Docker socket

报错类似：

```text
Docker socket not found: /var/run/docker.sock
```

检查 Compose 挂载：

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

如果 NAS 的 Docker socket 不在默认路径，需要在环境变量中修改：

```env
DOCKPILOT_DOCKER_SOCKET=/实际/socket/路径
```

## 容器列表为空

可能原因：

- Docker socket 没有正确挂载。
- DockPilot 容器无权访问 socket。
- 当前宿主机没有容器。

检查：

```bash
docker exec -it dockpilot docker ps -a
```

如果容器内执行失败，说明 Docker CLI 或 socket 权限有问题。

## Compose 部署失败

DockPilot 容器内需要能执行：

```bash
docker compose version
```

检查：

```bash
docker exec -it dockpilot docker compose version
```

如果提示路径不存在，优先检查数据目录是否按“宿主机路径 = 容器内路径”的方式挂载。

推荐挂载：

```yaml
environment:
  DOCKPILOT_DATA: /volume1/docker/dockpilot/data
volumes:
  - /volume1/docker/dockpilot/data:/volume1/docker/dockpilot/data
```

## Compose 里的挂载路径不生效

Docker daemon 运行在宿主机，不运行在 DockPilot 容器内。

因此 Compose 文件中的宿主机路径必须是真实存在于 NAS 上的路径。

正确：

```yaml
volumes:
  - /volume1/docker/app:/config
```

错误：

```yaml
volumes:
  - /app/data:/config
```

除非 `/app/data` 也是 NAS 宿主机真实路径。

## 检查更新一直失败

检查更新会执行 `docker pull`。

可能原因：

- NAS 无法访问镜像仓库。
- 私有镜像未登录。
- 镜像名是 `sha256:...`，无法按标签检查。
- 镜像仓库限流。

可以进入容器测试：

```bash
docker exec -it dockpilot docker pull 镜像名
```

私有仓库需要先在宿主机 Docker 中完成登录。

## 有更新数量不对

“有更新”依赖手动或批量执行“检查更新”后的结果。

建议操作：

1. 进入容器管理。
2. 点击“批量操作”。
3. 等待全部检查完成。
4. 再点击“有更新”筛选。

## 一键更新失败

一键更新会先创建备份，再更新。

失败后建议：

1. 查看页面错误提示。
2. 查看 DockPilot 日志。
3. 到“容器备份”中确认备份已生成。
4. 复杂容器建议恢复为 Compose，检查配置后再部署。

日志：

```bash
docker logs -f dockpilot
```

## 图标上传失败

限制：

- 格式必须是 PNG、JPG、WebP 或 GIF。
- 单个文件最大 6MB。

如果超过限制，页面会提示：

```text
图标不能超过 6MB。
```

## 文件管理看不到 NAS 目录

需要先挂载目录到 DockPilot 容器内。

示例：

```yaml
volumes:
  - /volume1/docker:/volume1/docker
  - /volume1/media:/volume1/media
```

然后在系统设置里添加文件根目录：

```text
docker=/volume1/docker
media=/volume1/media
```

## 忘记密码

当前版本没有网页重置密码功能。

如果是测试环境，可以停止服务后备份并删除数据库：

```text
data/dockpilot.db
```

重新启动后会再次进入首次管理员创建页。

生产环境不要直接删除数据库，因为导航卡片、设置和容器偏好也在里面。

## 页面样式没更新

浏览器可能缓存了 CSS 或 JS。

处理方式：

- 强制刷新浏览器。
- 清理浏览器缓存。
- 确认容器已经拉到最新镜像。

检查镜像：

```bash
docker inspect dockpilot --format '{{.Config.Image}}'
```

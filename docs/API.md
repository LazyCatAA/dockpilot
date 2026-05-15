# 接口说明

DockPilot 后端使用 Python 标准库 `http.server` 提供 JSON API。所有非公开接口都需要登录 Cookie。

默认地址：

```text
http://127.0.0.1:8088
```

## 认证

公开接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 查看是否需要初始化、是否已登录 |
| POST | `/api/setup` | 首次创建管理员 |
| POST | `/api/login` | 登录 |

登录成功后会写入 Cookie：

```text
dockpilot_session
```

退出登录：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/logout` | 清除当前会话 |

修改密码：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/account/password` | 修改当前管理员密码 |

请求体：

```json
{
  "current_password": "old-password",
  "new_password": "new-password"
}
```

## 总览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | Docker 状态、容器数量、导航卡片数量、Compose 项目数量 |

## 首页导航卡片

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cards` | 获取导航卡片 |
| POST | `/api/cards` | 新增导航卡片 |
| PUT | `/api/cards/{id}` | 更新导航卡片 |
| DELETE | `/api/cards/{id}` | 删除导航卡片 |

创建示例：

```json
{
  "title": "媒体库",
  "url": "http://192.168.1.10:8096",
  "group_name": "媒体",
  "icon": "JM",
  "color": "#2f80ed"
}
```

## Docker 容器

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/docker/status` | Docker socket 状态 |
| GET | `/api/docker/containers` | 容器列表 |
| GET | `/api/docker/images` | 镜像列表 |
| GET | `/api/docker/containers/{id}/inspect` | 容器详情 |
| GET | `/api/docker/containers/{id}/logs` | 容器日志 |
| POST | `/api/docker/containers/{id}/start` | 启动容器 |
| POST | `/api/docker/containers/{id}/stop` | 停止容器 |
| POST | `/api/docker/containers/{id}/restart` | 重启容器 |
| DELETE | `/api/docker/containers/{id}/remove` | 删除容器 |

容器偏好：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/docker/containers/{id}/pref` | 保存卡片颜色或自定义图标 |

保存颜色示例：

```json
{
  "container_key": "nginx",
  "color": "#16a36a"
}
```

保存图标示例：

```json
{
  "container_key": "nginx",
  "icon_mime": "image/png",
  "icon_content_base64": "..."
}
```

图标限制：

- 支持 `image/png`
- 支持 `image/jpeg`
- 支持 `image/webp`
- 支持 `image/gif`
- 最大 6MB

更新相关：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/docker/containers/{id}/check-update` | 拉取镜像并检查是否有更新 |
| POST | `/api/docker/containers/{id}/update` | 自动备份并更新容器 |

备份恢复：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/docker/backups` | 获取容器备份列表 |
| POST | `/api/docker/containers/{id}/backup` | 创建容器备份 |
| POST | `/api/docker/backups/{name}` | 恢复备份为 Compose 项目 |

## Compose

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/compose/projects` | 获取 Compose 项目列表和服务状态 |
| POST | `/api/compose/projects` | 新建 Compose 项目 |
| GET | `/api/compose/file?path=...` | 读取 Compose 文件 |
| PUT | `/api/compose/file` | 保存 Compose 文件 |
| POST | `/api/compose/action` | 执行 Compose 动作 |
| POST | `/api/compose/from-command` | 将 `docker run` 命令转为 Compose，可选直接部署 |

Compose 动作：

- `config`
- `pull`
- `up`
- `restart`
- `logs`
- `down`

执行动作示例：

```json
{
  "path": "/volume1/docker/dockpilot/data/stacks/nginx/compose.yml",
  "action": "up"
}
```

命令转 Compose 示例：

```json
{
  "name": "nginx-demo",
  "command": "docker run -d --name nginx-demo -p 8080:80 nginx:alpine",
  "deploy": true
}
```

## 文件管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files/roots` | 获取文件根目录 |
| GET | `/api/files/list?root=...&path=...` | 列目录 |
| GET | `/api/files/read?root=...&path=...` | 读取文本文件 |
| GET | `/api/files/download?root=...&path=...` | 下载文件 |
| PUT | `/api/files/write` | 写入文本文件 |
| POST | `/api/files/upload` | 上传文件 |
| POST | `/api/files/mkdir` | 新建目录 |
| POST | `/api/files/rename` | 重命名 |
| POST | `/api/files/copy` | 复制 |
| POST | `/api/files/move` | 移动 |
| DELETE | `/api/files/delete?root=...&path=...` | 删除 |

## 系统设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 获取系统设置 |
| PUT | `/api/settings` | 保存系统设置 |

示例：

```json
{
  "docker_socket": "/var/run/docker.sock",
  "compose_roots": ["/volume1/docker/dockpilot/data/stacks"],
  "file_roots": [
    {
      "name": "docker",
      "path": "/volume1/docker"
    }
  ]
}
```

## 错误格式

错误响应通常为：

```json
{
  "error": "message"
}
```

常见状态码：

- `400`：请求参数错误。
- `401`：未登录或会话过期。
- `404`：资源不存在。
- `409`：资源冲突。
- `502`：Docker 或 Compose 操作失败。

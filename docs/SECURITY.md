# 安全说明

DockPilot 能直接管理宿主机 Docker，因此应按高权限管理面板对待。

## 权限边界

DockPilot 通过挂载 Docker socket 管理宿主机：

```text
/var/run/docker.sock
```

拥有该 socket 访问权限，基本等同于拥有宿主机 Docker 管理权限。

因此：

- 不要暴露到公网。
- 不要给不可信用户账号。
- 不要在未知网络中开放端口。
- 建议只在内网或 VPN 中访问。

## 账号和会话

当前版本支持：

- 首次创建管理员。
- Cookie 会话。
- 修改密码。

当前版本不支持：

- 多用户。
- 角色权限。
- 二次验证。
- 登录失败锁定。

建议：

- 使用强密码。
- 不要复用其他重要账号密码。
- 反向代理时开启 HTTPS。

## 反向代理建议

如果需要通过域名访问，建议在反向代理层启用：

- HTTPS。
- 访问控制。
- 基础认证或 SSO。
- 内网 IP 白名单。

Nginx 代理示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 文件管理安全

文件管理只允许访问系统设置里配置的根目录。

后端会校验路径，防止越过根目录。

仍需注意：

- 不要把 `/` 作为文件根目录。
- 不要把敏感系统目录暴露给 DockPilot。
- 只挂载实际需要管理的目录。

## Compose 和命令部署风险

Compose 部署和 `docker run` 命令转换可以创建新容器。

风险包括：

- 挂载宿主机敏感目录。
- 使用特权模式。
- 暴露危险端口。
- 运行不可信镜像。

部署前应检查 Compose 内容。

## 容器更新风险

一键更新会自动拉取镜像并重建容器。

更新前 DockPilot 会自动创建容器备份，但复杂容器仍建议：

1. 手动创建备份。
2. 检查备份生成的 Compose 文件。
3. 确认数据目录已正确挂载。
4. 再执行更新。

## 数据库和备份

核心数据在：

```text
data/dockpilot.db
```

容器备份在：

```text
data/backups/containers
```

建议定期备份整个 `data` 目录。

## 公网暴露说明

当前版本不建议直接公网暴露。

如果必须公网访问，至少需要：

- HTTPS。
- 强密码。
- 反向代理访问控制。
- 防火墙限制来源 IP。
- 定期更新镜像。

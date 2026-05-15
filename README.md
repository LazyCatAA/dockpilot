# DockPilot

DockPilot 是一个面向 NAS 和私有服务器的 Docker 管理面板。当前版本重点覆盖容器管理、Compose 管理、命令转 Compose、文件管理、首页导航和基础账号安全。

项目特点：

- 中文界面，首次启动创建管理员账号。
- 容器卡片管理：启动、停止、重启、日志、详情、备份、恢复、更新检查、一键更新。
- 容器顶部统计支持点击筛选：总容器、运行中、已停止、有更新。
- 容器图标支持上传，单个图标最大 6MB。
- Compose 管理：发现项目、在线编辑、部署、停止、重启、拉取、检查配置、查看日志。
- 支持把 `docker run` 命令转换为 Compose 项目，并可直接部署。
- 桌面端左侧菜单可隐藏，手机端自动切换为底部导航。
- 无前端构建步骤，无额外 Python 依赖，容器镜像内置 Docker CLI 和 Compose v2 插件。

## 快速运行

本机调试：

```bash
python3 -m dockpilot.server --host 127.0.0.1 --port 8088
```

或使用脚本：

```bash
scripts/start_local.sh
scripts/status_local.sh
scripts/stop_local.sh
```

访问地址：

```text
http://127.0.0.1:8088
```

NAS 拉镜像部署使用：

```text
ghcr.io/lazycataa/dockpilot:latest
```

固定版本示例：

```text
ghcr.io/lazycataa/dockpilot:sha-提交短哈希
```

## 文档目录

- [部署指南](docs/DEPLOYMENT.md)
- [使用手册](docs/USER_GUIDE.md)
- [接口说明](docs/API.md)
- [开发说明](docs/DEVELOPMENT.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [安全说明](docs/SECURITY.md)
- [验收记录](ACCEPTANCE.md)

## 目录结构

```text
.
├── dockpilot/              # Python 标准库后端
├── web/                    # 原生 HTML/CSS/JS 前端
├── scripts/                # 本机启动和冒烟测试脚本
├── docs/                   # 项目文档
├── Dockerfile              # 容器镜像构建
├── docker-compose.yml      # 源码构建部署
├── docker-compose.image.yml # 拉取镜像部署
├── .env.example            # 镜像部署环境变量模板
└── ACCEPTANCE.md           # 当前验收记录
```

## 本地测试

```bash
python3 -m py_compile dockpilot/server.py scripts/smoke_test.py
node --check web/app.js
python3 scripts/smoke_test.py
```

冒烟测试会自动启动一个临时 DockPilot 服务并使用临时数据目录，不会影响正在运行的 `8088` 服务。

## 当前限制

- 本机如果没有 Docker，只能验证界面、账号、文件、Compose 文件读写等非 Docker 运行能力。
- 容器更新、Compose 部署、日志、启停等动作需要部署到有 `/var/run/docker.sock` 的 NAS 或 Linux 主机后验收。
- 多用户权限、网页终端、远程 Agent、通知机器人还未实现，建议作为下一阶段功能。

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent


class Client:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.cookies = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, method: str, path: str, body: Any | None = None, expect: int | tuple[int, ...] = 200) -> tuple[int, Any]:
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=8) as response:
                status = response.status
                raw = response.read()
                payload = parse_payload(raw, response.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as exc:
            status = exc.code
            raw = exc.read()
            payload = parse_payload(raw, exc.headers.get("Content-Type", ""))
        expected = expect if isinstance(expect, tuple) else (expect,)
        if status not in expected:
            raise AssertionError(f"{method} {path} expected {expect}, got {status}: {payload}")
        return status, payload


def parse_payload(raw: bytes, content_type: str) -> Any:
    if "application/json" in content_type:
        return json.loads(raw.decode("utf-8"))
    return raw.decode("utf-8", "replace")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_ready(client: Client) -> None:
    last_error: Exception | None = None
    for _ in range(50):
        try:
            client.request("GET", "/api/session")
            return
        except Exception as exc:
            last_error = exc
            time.sleep(0.1)
    raise RuntimeError(f"server did not become ready: {last_error}")


def assert_true(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)


def main() -> int:
    port = free_port()
    data_dir = Path(tempfile.mkdtemp(prefix="dockpilot-smoke-"))
    env = os.environ.copy()
    env["DOCKPILOT_DATA"] = str(data_dir)
    proc = subprocess.Popen(
        [sys.executable, "-m", "dockpilot.server", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    client = Client(f"http://127.0.0.1:{port}")
    try:
        wait_ready(client)

        _, session = client.request("GET", "/api/session")
        assert_true(session["setup_required"] is True, "首次启动应要求初始化")

        client.request("POST", "/api/setup", {"username": "admin", "password": "password123"})
        _, session = client.request("GET", "/api/session")
        assert_true(session["authenticated"] is True, "初始化后应处于登录状态")

        _, page = client.request("GET", "/")
        assert_true("DockPilot" in page, "首页静态文件应可访问")
        _, app_js = client.request("GET", "/app.js")
        assert_true("首页导航" in app_js, "前端脚本应为中文界面")
        assert_true("update-job" in app_js, "容器更新应使用后台任务接口")
        assert_true("containerUpdateJobs" in app_js, "容器更新任务应按容器分别跟踪")
        assert_true("scheduleContainerUpdateChecks" in app_js, "容器页应自动调度更新检测")
        assert_true("renderContainerCardUpdateProgress" in app_js, "更新进度应显示在对应容器卡片上")
        assert_true("update_check_error" in app_js, "更新检测失败时不应静默覆盖更新状态")
        assert_true("containerImageName" in app_js, "容器卡片应优先显示解析后的镜像名")
        assert_true("镜像库" in app_js, "前端应包含镜像库页面")
        assert_true("imagePullForm" in app_js, "镜像库应支持拉取镜像")
        assert_true("imageRemoteSearchForm" in app_js, "镜像库应支持远程搜索镜像")
        assert_true("pull_mode" in app_js, "镜像库拉取镜像应可选择下载方式")
        assert_true("imagePullJob" in app_js, "镜像拉取应使用带进度的后台任务")
        assert_true("scheduleImageProxyTest" in app_js, "镜像代理应自动连通检测")
        assert_true("proxyStatusText" in app_js, "镜像代理连通性应显示明确状态文案")
        assert_true("image-usage" in app_js, "镜像库应区分已使用和未使用镜像")
        assert_true("registry_mirrors" in app_js, "镜像库应支持多个镜像加速源")
        assert_true("compose-repair" in app_js, "Compose 编辑器应支持检查并修正")
        assert_true("container-backups-clear" in app_js, "容器备份应支持一键清理")
        assert_true("container-backup-delete" in app_js, "容器备份应支持删除")
        assert_true("bookmark-board" in app_js, "首页导航应使用分组书签板")
        assert_true("bookmark-context-menu" in app_js, "书签卡片应支持右键菜单")
        assert_true("cardIconUpload" in app_js, "书签卡片应支持图标上传")
        assert_true("cardModal" in app_js, "书签卡片应使用弹窗添加和编辑")
        _, styles_css = client.request("GET", "/styles.css")
        assert_true("container-card-update-progress" in styles_css, "容器更新应提供卡片内进度条样式")
        assert_true("repeat(4, minmax(0, 1fr))" in styles_css, "桌面端容器卡片应为四列紧凑布局")
        assert_true("min-height: 116px" in styles_css, "容器卡片高度应压缩为紧凑尺寸")
        assert_true("min-height: 28px" in styles_css, "容器操作按钮应使用紧凑高度")
        assert_true("image-search-results" in styles_css, "镜像库应提供搜索结果样式")
        assert_true("image-tool-card" in styles_css, "镜像库功能区应使用分区卡片")
        assert_true("image-pull-progress" in styles_css, "镜像拉取应提供进度条样式")
        assert_true("image-group-section" in app_js, "镜像库本地镜像应按状态分组展示")
        assert_true("image-status-dot" in app_js, "镜像卡片应提供状态圆点")
        assert_true("image-card-shell" in styles_css, "镜像库卡片应使用专业化卡片壳层")
        assert_true("image-card-actions" in styles_css, "镜像库卡片操作区应紧凑收敛")
        assert_true("backup-actions" in styles_css, "容器备份应提供恢复和删除操作样式")
        assert_true("bookmark-card" in styles_css, "书签卡片应提供复刻样式")
        assert_true("nav-hero" in styles_css, "首页导航应使用重新设计的导航头部")
        assert_true("compose-repair-note" in styles_css, "Compose 修正结果应有提示样式")
        assert_true("yaml-repaired" in styles_css, "Compose 修正内容应高亮显示")
        assert_true("compose-panel" in styles_css, "Compose 管理功能卡片应使用彩色区分")
        _, update_job = client.request("POST", "/api/docker/containers/fake-container/update-job", expect=202)
        job_id = update_job["job"]["id"]
        _, job_state = client.request("GET", f"/api/docker/jobs/{job_id}")
        assert_true(job_state["job"]["container_id"] == "fake-container", "更新任务应记录容器 ID")

        _, overview = client.request("GET", "/api/overview")
        assert_true("docker" in overview, "总览应包含 Docker 状态")

        _, created_card = client.request(
            "POST",
            "/api/cards",
            {
                "title": "测试服务",
                "url": "http://127.0.0.1",
                "internal_url": "http://192.168.1.200:8080",
                "description": "第一行\n第二行",
                "group_name": "应用",
                "icon": "测",
                "color": "#2f80ed",
                "title_color": "#111827",
                "card_color": "#ffffff",
                "size": "large",
                "style": "soft",
                "icon_mime": "image/gif",
                "icon_content_base64": "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
            },
            expect=201,
        )
        card_id = created_card["card"]["id"]
        assert_true(created_card["card"]["internal_url"] == "http://192.168.1.200:8080", "导航卡片应保存内网地址")
        assert_true(created_card["card"]["description"] == "第一行\n第二行", "导航卡片应保存描述")
        assert_true(created_card["card"]["title_color"] == "#111827", "导航卡片应保存标题颜色")
        assert_true(created_card["card"]["card_color"] == "#ffffff", "导航卡片应保存卡片颜色")
        assert_true(created_card["card"]["size"] == "large", "导航卡片应保存尺寸")
        assert_true(created_card["card"]["style"] == "soft", "导航卡片应保存样式")
        assert_true(created_card["card"]["icon_data"].startswith("data:image/gif;base64,"), "导航卡片应保存上传图标")
        client.request("PUT", f"/api/cards/{card_id}", {"title": "测试服务2", "sort_order": 5, "size": "small", "clear_icon": True})
        _, cards = client.request("GET", "/api/cards")
        assert_true(cards["cards"][0]["title"] == "测试服务2", "导航卡片应可编辑")
        assert_true(cards["cards"][0]["size"] == "small", "导航卡片尺寸应可编辑")
        assert_true(cards["cards"][0]["icon_data"] == "", "导航卡片图标应可清除")

        _, project = client.request("POST", "/api/compose/projects", {"name": "demo"}, expect=201)
        compose_path = urllib.parse.quote(project["project"]["path"], safe="")
        _, compose_file = client.request("GET", f"/api/compose/file?path={compose_path}")
        assert_true("services:" in compose_file["content"], "Compose 文件应可读取")
        client.request(
            "PUT",
            "/api/compose/file",
            {"path": project["project"]["path"], "content": compose_file["content"] + "\n# smoke\n"},
        )
        _, from_command = client.request(
            "POST",
            "/api/compose/from-command",
            {"name": "cmd-demo", "command": "docker run -d --name cmd-demo -p 8090:80 -e TZ=Asia/Shanghai nginx:alpine"},
            expect=201,
        )
        _, command_compose = client.request("GET", f"/api/compose/file?path={urllib.parse.quote(from_command['project']['path'], safe='')}")
        assert_true("image: nginx:alpine" in command_compose["content"], "docker run 命令应可转换为 Compose")
        assert_true("8090:80" in command_compose["content"], "docker run 端口应写入 Compose")

        client.request("PUT", "/api/files/write", {"root": "files", "path": "hello.txt", "content": "测试通过"})
        _, read_file = client.request("GET", "/api/files/read?root=files&path=hello.txt")
        assert_true(read_file["content"] == "测试通过", "文件内容应可读写")
        client.request("POST", "/api/files/mkdir", {"root": "files", "path": "", "name": "box"})
        client.request(
            "POST",
            "/api/files/copy",
            {"root": "files", "path": "hello.txt", "destination_root": "files", "destination_path": "box/copy.txt"},
        )
        client.request(
            "POST",
            "/api/files/move",
            {"root": "files", "path": "box/copy.txt", "destination_root": "files", "destination_path": "moved.txt"},
        )
        _, moved = client.request("GET", "/api/files/read?root=files&path=moved.txt")
        assert_true(moved["content"] == "测试通过", "文件复制和移动应保留内容")
        client.request("DELETE", "/api/files/delete?root=files&path=moved.txt")

        client.request(
            "POST",
            "/api/account/password",
            {"current_password": "password123", "new_password": "password456"},
        )
        client.request("POST", "/api/logout")
        client.request("POST", "/api/login", {"username": "admin", "password": "password123"}, expect=401)
        client.request("POST", "/api/login", {"username": "admin", "password": "password456"})

        docker_code, docker_status = client.request("GET", "/api/docker/containers", expect=(200, 502))
        if docker_code == 502:
            assert_true("Docker socket not found" in docker_status["error"], "无 Docker 环境时应返回明确错误")
        else:
            assert_true("containers" in docker_status, "有 Docker 环境时应返回容器列表")
        image_code, image_status = client.request("GET", "/api/docker/images", expect=(200, 502))
        if image_code == 502:
            assert_true("Docker socket not found" in image_status["error"], "无 Docker 环境时镜像库应返回明确错误")
        else:
            assert_true("images" in image_status, "有 Docker 环境时应返回镜像列表")
        _, pref = client.request(
            "POST",
            "/api/docker/containers/fake-container/pref",
            {"container_key": "fake-container", "color": "#16a36a"},
        )
        assert_true(pref["pref"]["color"] == "#16a36a", "容器卡片颜色偏好应可保存")
        _, icon_pref = client.request(
            "POST",
            "/api/docker/containers/fake-container/pref",
            {
                "container_key": "fake-container",
                "icon_mime": "image/gif",
                "icon_content_base64": "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
            },
        )
        assert_true(icon_pref["pref"]["icon_data"].startswith("data:image/gif;base64,"), "容器自定义图标应可保存")
        _, backups = client.request("GET", "/api/docker/backups")
        assert_true("backups" in backups, "容器备份列表应可读取")
        fake_backup = data_dir / "backups" / "containers" / "smoke.json"
        fake_backup.parent.mkdir(parents=True, exist_ok=True)
        fake_backup.write_text(
            json.dumps({"container_name": "smoke", "image": "nginx:latest", "created_at": "20260515-200000"}),
            encoding="utf-8",
        )
        _, backups = client.request("GET", "/api/docker/backups")
        assert_true(any(item["name"] == "smoke.json" for item in backups["backups"]), "容器备份列表应显示备份文件")
        client.request("DELETE", "/api/docker/backups/smoke.json")
        _, backups = client.request("GET", "/api/docker/backups")
        assert_true(not any(item["name"] == "smoke.json" for item in backups["backups"]), "容器备份应可删除")
        fake_backup.write_text(json.dumps({"container_name": "smoke", "image": "nginx:latest"}), encoding="utf-8")
        _, cleared = client.request("DELETE", "/api/docker/backups/clear")
        assert_true(cleared["deleted"] >= 1, "容器备份应可一键清理")
        client.request("GET", "/api/docker/images/search?q=", expect=400)
        _, repaired = client.request("POST", "/api/compose/repair", {"content": "app：\n\timage: nginx\n"})
        assert_true(repaired["changed"] is True, "Compose 修复接口应返回修正后的内容")

        client.request("DELETE", f"/api/cards/{card_id}")
        print("PASS: DockPilot 冒烟测试全部通过")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        if proc.returncode not in (0, -15, None):
            output = proc.stdout.read() if proc.stdout else ""
            print(output)
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

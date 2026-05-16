from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dockpilot import server
from dockpilot.server import (
    build_image_name_lookup,
    direct_image_search_result,
    clear_container_backups,
    enrich_containers,
    enrich_images_with_usage,
    normalize_image_search_query,
    normalize_network_proxy_url,
    normalize_registry_mirrors,
    proxied_image_reference,
    recreate_standalone_container,
    repair_compose_content,
)


def assert_true(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)


class FakeDocker:
    def __init__(self) -> None:
        self.rename_calls: list[str] = []

    def request(self, method: str, path: str, query=None, body=None, timeout: int = 30):
        if method == "POST" and path.endswith("/rename"):
            name = str((query or {}).get("name", ""))
            self.rename_calls.append(name)
            if len(self.rename_calls) == 1:
                return 400, b'{"message":"Renaming a container with the same name as its current name"}', "Bad Request"
            return 204, b"", "No Content"
        if method == "DELETE":
            return 204, b"", "No Content"
        return 204, b"", "No Content"

    def json(self, method: str, path: str, query=None, body=None):
        if method == "POST" and path == "/containers/create":
            return {"Id": "new-container-id"}
        raise AssertionError(f"unexpected json call: {method} {path}")


def test_standalone_update_retries_when_docker_reports_same_rename_name() -> None:
    docker = FakeDocker()
    inspect_data = {
        "Id": "abcdef1234567890",
        "Name": "/demo",
        "Config": {"Image": "nginx:latest"},
        "State": {"Running": False},
        "HostConfig": {},
        "NetworkSettings": {"Networks": {}},
    }

    result = recreate_standalone_container(docker, inspect_data)

    assert_true(result["ok"] is True, "同名重命名报错后应重新生成备份名并继续更新")
    assert_true(len(docker.rename_calls) == 2, "应重试一次旧容器重命名")
    assert_true(docker.rename_calls[0] != docker.rename_calls[1], "重试时应使用新的备份名")


def test_image_proxy_keeps_original_reference_shape() -> None:
    assert_true(
        proxied_image_reference("nginx:latest", "mirror.example.com") == "mirror.example.com/library/nginx:latest",
        "单段 Docker Hub 镜像应自动补 library 命名空间",
    )
    assert_true(
        proxied_image_reference("linuxserver/qbittorrent:latest", "mirror.example.com")
        == "mirror.example.com/linuxserver/qbittorrent:latest",
        "带命名空间的 Docker Hub 镜像应追加到代理前缀后",
    )
    assert_true(
        proxied_image_reference("ghcr.io/user/app:latest", "https://mirror.example.com/")
        == "mirror.example.com/ghcr.io/user/app:latest",
        "带 registry 的镜像应保留完整原始路径并清理代理协议",
    )


def test_registry_mirrors_support_multiple_sources() -> None:
    mirrors = normalize_registry_mirrors("https://docker.1ms.run\ndocker.1panel.live")
    assert_true(mirrors == ["docker.1ms.run", "docker.1panel.live"], "镜像加速源应支持多行配置")
    assert_true(
        proxied_image_reference("nginx:latest", mirrors[1]) == "docker.1panel.live/library/nginx:latest",
        "应可选择指定镜像加速源拉取",
    )


def test_pull_image_can_skip_configured_proxy() -> None:
    calls: list[list[str]] = []
    original = server.run_docker_cli
    original_get_setting = server.STORE.get_setting
    try:
        def fake_run(args, socket_path=None, timeout=300, cwd=None):
            calls.append(args)
            return server.subprocess.CompletedProcess(["docker", *args], 0, "pulled\n")

        server.STORE.get_setting = lambda key, fallback="": "mirror.example.com" if key == "image_registry_proxy" else fallback
        server.run_docker_cli = fake_run
        result = server.pull_image_with_proxy("nginx:latest", use_proxy=False)
    finally:
        server.run_docker_cli = original
        server.STORE.get_setting = original_get_setting

    assert_true(result["ok"] is True, "不使用代理时镜像仍应拉取成功")
    assert_true(calls == [["pull", "nginx:latest"]], "不使用代理时不应改写镜像地址或执行 tag")


def test_check_update_uses_docker_api_when_cli_is_unavailable() -> None:
    class FakeDocker:
        def request(self, method, path, query=None, body=None, timeout=30):
            if method == "POST" and path == "/images/create":
                assert_true(query == {"fromImage": "nginx", "tag": "latest"}, "Docker API 拉取应拆分镜像名和 tag")
                return 200, b'{"status":"Downloaded newer image"}\n', "OK"
            if method == "GET" and path.startswith("/images/"):
                return 200, b'{"Id":"sha256:new-image","RepoDigests":["nginx@sha256:newdigest"]}', "OK"
            raise AssertionError(f"unexpected request: {method} {path}")

        def json(self, method, path, query=None, body=None):
            if method == "GET" and path.startswith("/images/"):
                return {"Id": "sha256:new-image", "RepoDigests": ["nginx@sha256:newdigest"]}
            raise AssertionError(f"unexpected json call: {method} {path}")

    original_run = server.run_docker_cli
    original_client = server.DockerClient
    try:
        def missing_cli(*args, **kwargs):
            raise FileNotFoundError("docker")

        server.run_docker_cli = missing_cli
        server.DockerClient = lambda socket_path: FakeDocker()
        result = server.check_container_update(
            {"Image": "sha256:old-image", "Config": {"Image": "nginx:latest"}},
            "/var/run/docker.sock",
        )
    finally:
        server.run_docker_cli = original_run
        server.DockerClient = original_client

    assert_true(result["ok"] is True, "docker CLI 不可用时应通过 Docker API 继续检测")
    assert_true(result["update_available"] is True, "远端镜像 ID 变化时应标记为有更新")
    assert_true(result["latest_image_id"] == "sha256:new-image", "结果应返回最新镜像 ID 便于排查")


def test_delete_container_backup_removes_backup_file() -> None:
    original_data_dir = server.DATA_DIR
    with tempfile.TemporaryDirectory() as tmp:
        server.DATA_DIR = Path(tmp)
        path = server.backup_file_path("demo.json")
        path.write_text(json.dumps({"container_name": "demo", "image": "nginx:latest"}), encoding="utf-8")
        result = server.delete_container_backup("demo.json")
        assert_true(result["ok"] is True, "删除备份应返回 ok")
        assert_true(not path.exists(), "删除备份后文件不应继续存在")
    server.DATA_DIR = original_data_dir


def test_clear_container_backups_removes_all_backup_files() -> None:
    original_data_dir = server.DATA_DIR
    with tempfile.TemporaryDirectory() as tmp:
        server.DATA_DIR = Path(tmp)
        server.backup_file_path("one.json").write_text("{}", encoding="utf-8")
        server.backup_file_path("two.json").write_text("{}", encoding="utf-8")
        result = clear_container_backups()
        assert_true(result["deleted"] == 2, "一键清理应删除所有容器备份")
        assert_true(server.list_container_backups() == [], "一键清理后备份列表应为空")
    server.DATA_DIR = original_data_dir


def test_docker_hub_search_results_are_normalized() -> None:
    payload = {
        "results": [
            {
                "repo_name": "linuxserver/qbittorrent",
                "short_description": "Torrent client",
                "star_count": 123,
                "pull_count": 4567,
                "is_official": False,
            }
        ]
    }
    results = server.normalize_docker_hub_search_results(payload)
    assert_true(results[0]["name"] == "linuxserver/qbittorrent", "搜索结果应保留可拉取的镜像名")
    assert_true(results[0]["pull_name"] == "linuxserver/qbittorrent:latest", "搜索结果应提供 latest 拉取名")
    assert_true(results[0]["stars"] == 123, "搜索结果应保留星标数")


def test_failed_update_check_should_not_clear_existing_update_state() -> None:
    assert_true(
        server.should_persist_update_check_result({"ok": False, "update_available": False}) is False,
        "检测失败时不应把有更新状态覆盖为无更新",
    )
    assert_true(
        server.should_persist_update_check_result({"ok": True, "update_available": True}) is True,
        "检测成功时应保存更新状态",
    )


def test_container_card_uses_repo_tag_when_summary_image_is_digest() -> None:
    containers = [
        {
            "Id": "container-id",
            "Names": ["/symedia"],
            "Image": "sha256:dc77c7eaaa34641e1d9fac605fa6cbbc5590a7d004eb0800b788827a3870c5c",
            "ImageID": "sha256:dc77c7eaaa34641e1d9fac605fa6cbbc5590a7d004eb0800b788827a3870c5c",
        }
    ]
    images = [
        {
            "Id": "sha256:dc77c7eaaa34641e1d9fac605fa6cbbc5590a7d004eb0800b788827a3870c5c",
            "RepoTags": ["shenxianmq/symedia:latest"],
        }
    ]
    enriched = enrich_containers(containers, {}, build_image_name_lookup(images))
    assert_true(
        enriched[0]["DockPilot"]["image_name"] == "shenxianmq/symedia:latest",
        "容器摘要只有 sha256 时应通过本地镜像列表反查镜像名",
    )


def test_images_are_marked_used_when_container_references_image_id() -> None:
    images = [{"Id": "sha256:image-one", "RepoTags": ["demo/app:latest"]}, {"Id": "sha256:image-two", "RepoTags": ["demo/old:latest"]}]
    containers = [{"ImageID": "sha256:image-one", "Image": "demo/app:latest"}]
    enriched = enrich_images_with_usage(images, containers)
    assert_true(enriched[0]["DockPilot"]["used"] is True, "被容器引用的镜像应标记为已使用")
    assert_true(enriched[1]["DockPilot"]["used"] is False, "未被容器引用的镜像应标记为未使用")


def test_remote_image_search_strips_tag_from_full_reference() -> None:
    assert_true(
        normalize_image_search_query("shenxianmq/symedia:latest") == "shenxianmq/symedia",
        "远程搜索完整镜像引用时应去掉 tag",
    )
    direct = direct_image_search_result("shenxianmq/symedia:latest")
    assert_true(direct["pull_name"] == "shenxianmq/symedia:latest", "完整镜像引用应保留为可直接拉取结果")


def test_network_proxy_url_is_normalized_for_lan_proxy() -> None:
    assert_true(
        normalize_network_proxy_url("192.168.1.2:7890") == "http://192.168.1.2:7890",
        "局域网代理未写协议时应默认补 http",
    )
    assert_true(
        normalize_network_proxy_url("socks5://192.168.1.2:7890") == "socks5://192.168.1.2:7890",
        "SOCKS5 代理应保留协议",
    )


def test_compose_repair_fixes_common_yaml_format_issues() -> None:
    result = repair_compose_content("app：\n\timage: nginx\n\tports:\n\t\t- 8080:80\n")
    assert_true(result["changed"] is True, "Compose 修正应报告内容变化")
    assert_true("services:" in result["content"], "缺少 services 时应补充根节点")
    assert_true('"8080:80"' in result["content"], "端口映射应自动加引号")


def test_compose_repair_uses_compose_error_context() -> None:
    content = "services:\n  app:\n    image: nginx\n    ports:\n      - 8080:80\n"
    error = "services.app.ports.0 must be a string"
    result = repair_compose_content(content, error)
    assert_true('"8080:80"' in result["content"], "Compose 报端口类型错误时应自动加引号")
    assert_true(result["repaired_lines"] == [5], "Compose 修正应返回被修改的行号用于高亮")


def main() -> int:
    test_standalone_update_retries_when_docker_reports_same_rename_name()
    test_image_proxy_keeps_original_reference_shape()
    test_registry_mirrors_support_multiple_sources()
    test_pull_image_can_skip_configured_proxy()
    test_check_update_uses_docker_api_when_cli_is_unavailable()
    test_delete_container_backup_removes_backup_file()
    test_clear_container_backups_removes_all_backup_files()
    test_docker_hub_search_results_are_normalized()
    test_failed_update_check_should_not_clear_existing_update_state()
    test_container_card_uses_repo_tag_when_summary_image_is_digest()
    test_images_are_marked_used_when_container_references_image_id()
    test_remote_image_search_strips_tag_from_full_reference()
    test_network_proxy_url_is_normalized_for_lan_proxy()
    test_compose_repair_fixes_common_yaml_format_issues()
    test_compose_repair_uses_compose_error_context()
    print("PASS: DockPilot 单元测试全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

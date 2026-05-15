from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dockpilot.server import proxied_image_reference, recreate_standalone_container


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


def main() -> int:
    test_standalone_update_retries_when_docker_reports_same_rename_name()
    test_image_proxy_keeps_original_reference_shape()
    print("PASS: DockPilot 单元测试全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

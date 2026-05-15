from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "web"
DATA_DIR = Path(os.environ.get("DOCKPILOT_DATA", APP_ROOT / "data")).expanduser().resolve()
DB_PATH = DATA_DIR / "dockpilot.db"
DEFAULT_DOCKER_SOCKET = os.environ.get("DOCKPILOT_DOCKER_SOCKET", "/var/run/docker.sock")
SESSION_COOKIE = "dockpilot_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
MAX_JSON_BYTES = 25 * 1024 * 1024
TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024


def now_ts() -> int:
    return int(time.time())


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def safe_name(value: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return cleaned or fallback


def normalize_card_url(value: str) -> str:
    url = value.strip()
    if not url:
        raise ValueError("title and url are required")
    if url.startswith("/"):
        if url.startswith("//"):
            raise ValueError("invalid url")
        return url
    if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", url):
        url = "http://" + url
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid url")
    return url


def normalize_color(value: str) -> str:
    color = value.strip() or "#2563eb"
    if not re.fullmatch(r"#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?(?:[0-9A-Fa-f]{2})?", color):
        return "#2563eb"
    return color


def read_json_setting(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


class Store:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        (DATA_DIR / "stacks").mkdir(parents=True, exist_ok=True)
        (DATA_DIR / "files").mkdir(parents=True, exist_ok=True)
        (DATA_DIR / "backups" / "containers").mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    iterations INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    group_name TEXT NOT NULL DEFAULT 'Apps',
                    icon TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT '#2563eb',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS container_prefs (
                    container_key TEXT PRIMARY KEY,
                    color TEXT NOT NULL DEFAULT '#2f80ed',
                    icon_data TEXT NOT NULL DEFAULT '',
                    update_available INTEGER NOT NULL DEFAULT 0,
                    update_checked_at INTEGER,
                    updated_at INTEGER NOT NULL
                );
                """
            )
            existing_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(container_prefs)").fetchall()
            }
            if "icon_data" not in existing_columns:
                conn.execute("ALTER TABLE container_prefs ADD COLUMN icon_data TEXT NOT NULL DEFAULT ''")
            defaults = {
                "docker_socket": DEFAULT_DOCKER_SOCKET,
                "compose_roots": json_dumps([str(DATA_DIR / "stacks")]),
                "file_roots": json_dumps(
                    [
                        {"name": "files", "path": str(DATA_DIR / "files")},
                        {"name": "stacks", "path": str(DATA_DIR / "stacks")},
                    ]
                ),
            }
            for key, value in defaults.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                    (key, value, now_ts()),
                )

    def get_setting(self, key: str, fallback: str = "") -> str:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return str(row["value"]) if row else fallback

    def set_setting(self, key: str, value: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, value, now_ts()),
            )

    def user_count(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()
            return int(row["count"])

    def create_user(self, username: str, password: str) -> sqlite3.Row:
        salt, password_hash, iterations = hash_password(password)
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO users(username,password_hash,salt,iterations,created_at) VALUES(?,?,?,?,?)",
                (username, password_hash, salt, iterations, now_ts()),
            )
            return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()

    def find_user(self, username: str) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()

    def find_user_by_id(self, user_id: int) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()

    def update_password(self, user_id: int, password: str) -> None:
        salt, password_hash, iterations = hash_password(password)
        with self.connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash=?, salt=?, iterations=? WHERE id=?",
                (password_hash, salt, iterations, user_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("user not found")
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(40)
        token_hash = hash_token(token)
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_ts(),))
            conn.execute(
                "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
                (token_hash, user_id, now_ts() + SESSION_TTL_SECONDS, now_ts()),
            )
        return token

    def get_session_user(self, token: str | None) -> sqlite3.Row | None:
        if not token:
            return None
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_ts(),))
            return conn.execute(
                """
                SELECT users.id, users.username
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash=? AND sessions.expires_at >= ?
                """,
                (hash_token(token), now_ts()),
            ).fetchone()

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (hash_token(token),))

    def list_cards(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM cards ORDER BY group_name COLLATE NOCASE, sort_order, id"
            ).fetchall()
            return [dict(row) for row in rows]

    def create_card(self, data: dict[str, Any]) -> dict[str, Any]:
        title = str(data.get("title", "")).strip()
        if not title:
            raise ValueError("title and url are required")
        url = normalize_card_url(str(data.get("url", "")))
        group_name = str(data.get("group_name", "Apps")).strip() or "Apps"
        icon = str(data.get("icon", "")).strip()
        color = normalize_color(str(data.get("color", "#2563eb")))
        with self.connect() as conn:
            row = conn.execute("SELECT COALESCE(MAX(sort_order),0)+10 AS next_order FROM cards").fetchone()
            cursor = conn.execute(
                """
                INSERT INTO cards(title,url,group_name,icon,color,sort_order,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                """,
                (title, url, group_name, icon, color, int(row["next_order"]), now_ts(), now_ts()),
            )
            created = conn.execute("SELECT * FROM cards WHERE id=?", (cursor.lastrowid,)).fetchone()
            return dict(created)

    def update_card(self, card_id: int, data: dict[str, Any]) -> dict[str, Any]:
        allowed = ["title", "url", "group_name", "icon", "color", "sort_order"]
        updates = []
        values: list[Any] = []
        for key in allowed:
            if key in data:
                if key == "title" and not str(data[key]).strip():
                    raise ValueError("title and url are required")
                if key == "url":
                    data[key] = normalize_card_url(str(data[key]))
                if key == "color":
                    data[key] = normalize_color(str(data[key]))
                if key == "sort_order":
                    data[key] = int(data[key])
                updates.append(f"{key}=?")
                values.append(data[key])
        if not updates:
            raise ValueError("no fields to update")
        updates.append("updated_at=?")
        values.append(now_ts())
        values.append(card_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE cards SET {','.join(updates)} WHERE id=?", values)
            row = conn.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
            if not row:
                raise LookupError("card not found")
            return dict(row)

    def delete_card(self, card_id: int) -> None:
        with self.connect() as conn:
            cursor = conn.execute("DELETE FROM cards WHERE id=?", (card_id,))
            if cursor.rowcount == 0:
                raise LookupError("card not found")

    def get_container_prefs(self) -> dict[str, dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM container_prefs").fetchall()
            return {
                row["container_key"]: {
                    "color": row["color"],
                    "icon_data": row["icon_data"],
                    "update_available": bool(row["update_available"]),
                    "update_checked_at": row["update_checked_at"],
                }
                for row in rows
            }

    def set_container_pref(
        self,
        container_key: str,
        color: str | None = None,
        update_available: bool | None = None,
        icon_data: str | None = None,
    ) -> dict[str, Any]:
        if not container_key:
            raise ValueError("container key is required")
        current = self.get_container_prefs().get(container_key, {})
        fallback_color = color_from_text(container_key)
        next_color = normalize_color(color if color is not None else str(current.get("color", fallback_color)))
        next_icon = str(current.get("icon_data", "")) if icon_data is None else icon_data
        next_update = bool(current.get("update_available", False)) if update_available is None else bool(update_available)
        checked_at = current.get("update_checked_at")
        if update_available is not None:
            checked_at = now_ts()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO container_prefs(container_key,color,icon_data,update_available,update_checked_at,updated_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(container_key) DO UPDATE SET
                  color=excluded.color,
                  icon_data=excluded.icon_data,
                  update_available=excluded.update_available,
                  update_checked_at=excluded.update_checked_at,
                  updated_at=excluded.updated_at
                """,
                (container_key, next_color, next_icon, int(next_update), checked_at, now_ts()),
            )
        return {
            "container_key": container_key,
            "color": next_color,
            "icon_data": next_icon,
            "update_available": next_update,
            "update_checked_at": checked_at,
        }


def hash_password(password: str, salt: str | None = None, iterations: int = 260_000) -> tuple[str, str, int]:
    salt_bytes = base64.b64decode(salt) if salt else secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, iterations)
    return base64.b64encode(salt_bytes).decode("ascii"), base64.b64encode(derived).decode("ascii"), iterations


def verify_password(password: str, row: sqlite3.Row) -> bool:
    _, password_hash, _ = hash_password(password, row["salt"], int(row["iterations"]))
    return hmac.compare_digest(password_hash, row["password_hash"])


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: int = 30) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


class DockerClient:
    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path

    def request(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        timeout: int = 30,
    ) -> tuple[int, bytes, str]:
        if not Path(self.socket_path).exists():
            raise RuntimeError(f"Docker socket not found: {self.socket_path}")
        encoded_query = urllib.parse.urlencode(query or {}, doseq=True)
        target = path + (f"?{encoded_query}" if encoded_query else "")
        payload: bytes | None = None
        headers: dict[str, str] = {}
        if body is not None:
            payload = json_dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(payload))
        conn = UnixHTTPConnection(self.socket_path, timeout=timeout)
        try:
            conn.request(method, target, body=payload, headers=headers)
            response = conn.getresponse()
            data = response.read()
            return response.status, data, response.reason
        finally:
            conn.close()

    def json(self, method: str, path: str, query: dict[str, Any] | None = None, body: Any | None = None) -> Any:
        status, data, reason = self.request(method, path, query=query, body=body)
        if status >= 400:
            message = data.decode("utf-8", "replace") or reason
            raise RuntimeError(f"Docker API {status}: {message}")
        if not data:
            return None
        return json.loads(data.decode("utf-8"))

    def ping(self) -> dict[str, Any]:
        status, data, reason = self.request("GET", "/_ping", timeout=5)
        return {"available": status == 200, "status": status, "message": data.decode("utf-8", "replace") or reason}


def decode_docker_stream(data: bytes) -> str:
    chunks: list[bytes] = []
    i = 0
    while i + 8 <= len(data) and data[i] in (0, 1, 2):
        size = int.from_bytes(data[i + 4 : i + 8], "big")
        start = i + 8
        end = start + size
        if size < 0 or end > len(data):
            break
        chunks.append(data[start:end])
        i = end
    if chunks and i == len(data):
        data = b"".join(chunks)
    return data.decode("utf-8", "replace")


STORE = Store(DB_PATH)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "DockPilot/0.1"
    protocol_version = "HTTP/1.1"

    user: sqlite3.Row | None = None

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:
        self.dispatch()

    def do_POST(self) -> None:
        self.dispatch()

    def do_PUT(self) -> None:
        self.dispatch()

    def do_DELETE(self) -> None:
        self.dispatch()

    def dispatch(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self.handle_api(parsed)
            else:
                self.serve_static(parsed.path)
        except BrokenPipeError:
            return
        except Exception as exc:
            self.write_json({"error": str(exc)}, status=500)

    def handle_api(self, parsed: urllib.parse.ParseResult) -> None:
        path = parsed.path
        public_paths = {"/api/session", "/api/setup", "/api/login"}
        if path not in public_paths:
            self.user = STORE.get_session_user(self.cookie_value(SESSION_COOKIE))
            if not self.user:
                self.write_json({"error": "authentication required"}, status=401)
                return

        if path == "/api/session" and self.command == "GET":
            user = STORE.get_session_user(self.cookie_value(SESSION_COOKIE))
            self.write_json(
                {
                    "setup_required": STORE.user_count() == 0,
                    "authenticated": bool(user),
                    "user": {"id": user["id"], "username": user["username"]} if user else None,
                }
            )
            return
        if path == "/api/setup" and self.command == "POST":
            self.api_setup()
            return
        if path == "/api/login" and self.command == "POST":
            self.api_login()
            return
        if path == "/api/logout" and self.command == "POST":
            STORE.delete_session(self.cookie_value(SESSION_COOKIE))
            self.write_json({"ok": True}, headers={"Set-Cookie": self.expire_cookie()})
            return
        if path == "/api/account/password" and self.command == "POST":
            self.api_change_password()
            return
        if path == "/api/overview" and self.command == "GET":
            self.api_overview()
            return
        if path.startswith("/api/cards"):
            self.api_cards(path)
            return
        if path.startswith("/api/docker"):
            self.api_docker(path)
            return
        if path.startswith("/api/compose"):
            self.api_compose(path, parsed)
            return
        if path.startswith("/api/files"):
            self.api_files(path, parsed)
            return
        if path == "/api/settings":
            self.api_settings()
            return
        self.write_json({"error": "not found"}, status=404)

    def api_setup(self) -> None:
        if STORE.user_count() > 0:
            self.write_json({"error": "setup already completed"}, status=409)
            return
        data = self.read_json()
        username = str(data.get("username", "admin")).strip() or "admin"
        password = str(data.get("password", ""))
        if len(password) < 8:
            self.write_json({"error": "password must be at least 8 characters"}, status=400)
            return
        user = STORE.create_user(username, password)
        token = STORE.create_session(int(user["id"]))
        self.write_json({"ok": True, "user": {"id": user["id"], "username": user["username"]}}, headers={"Set-Cookie": self.session_cookie(token)})

    def api_change_password(self) -> None:
        data = self.read_json()
        current_password = str(data.get("current_password", ""))
        new_password = str(data.get("new_password", ""))
        if len(new_password) < 8:
            self.write_json({"error": "password must be at least 8 characters"}, status=400)
            return
        user = STORE.find_user_by_id(int(self.user["id"])) if self.user else None
        if not user or not verify_password(current_password, user):
            self.write_json({"error": "invalid username or password"}, status=401)
            return
        STORE.update_password(int(user["id"]), new_password)
        token = STORE.create_session(int(user["id"]))
        self.write_json({"ok": True}, headers={"Set-Cookie": self.session_cookie(token)})

    def api_login(self) -> None:
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        user = STORE.find_user(username)
        if not user or not verify_password(password, user):
            self.write_json({"error": "invalid username or password"}, status=401)
            return
        token = STORE.create_session(int(user["id"]))
        self.write_json({"ok": True, "user": {"id": user["id"], "username": user["username"]}}, headers={"Set-Cookie": self.session_cookie(token)})

    def api_overview(self) -> None:
        docker_status = {"available": False, "message": "not checked"}
        containers: list[Any] = []
        try:
            docker = self.docker()
            docker_status = docker.ping()
            if docker_status["available"]:
                containers = docker.json("GET", "/containers/json", query={"all": "1"})
        except Exception as exc:
            docker_status = {"available": False, "message": str(exc)}
        running = len([c for c in containers if str(c.get("State", "")).lower() == "running"])
        self.write_json(
            {
                "docker": docker_status,
                "containers": {"total": len(containers), "running": running, "stopped": max(len(containers) - running, 0)},
                "cards": len(STORE.list_cards()),
                "compose_projects": len(discover_compose_projects(self.compose_roots(), containers)),
            }
        )

    def api_cards(self, path: str) -> None:
        parts = path.strip("/").split("/")
        if self.command == "GET" and path == "/api/cards":
            self.write_json({"cards": STORE.list_cards()})
            return
        if self.command == "POST" and path == "/api/cards":
            try:
                card = STORE.create_card(self.read_json())
            except ValueError as exc:
                self.write_json({"error": str(exc)}, status=400)
                return
            self.write_json({"card": card}, status=201)
            return
        if len(parts) == 3 and parts[:2] == ["api", "cards"]:
            try:
                card_id = int(parts[2])
            except ValueError:
                self.write_json({"error": "invalid card id"}, status=400)
                return
            if self.command == "PUT":
                try:
                    self.write_json({"card": STORE.update_card(card_id, self.read_json())})
                except LookupError as exc:
                    self.write_json({"error": str(exc)}, status=404)
                except ValueError as exc:
                    self.write_json({"error": str(exc)}, status=400)
                return
            if self.command == "DELETE":
                try:
                    STORE.delete_card(card_id)
                    self.write_json({"ok": True})
                except LookupError as exc:
                    self.write_json({"error": str(exc)}, status=404)
                return
        self.write_json({"error": "not found"}, status=404)

    def api_docker(self, path: str) -> None:
        docker = self.docker()
        parts = path.strip("/").split("/")
        try:
            if path == "/api/docker/status" and self.command == "GET":
                self.write_json(docker.ping())
                return
            if path == "/api/docker/containers" and self.command == "GET":
                containers = docker.json("GET", "/containers/json", query={"all": "1", "size": "0"})
                containers = enrich_containers(containers, STORE.get_container_prefs())
                self.write_json({"containers": containers})
                return
            if path == "/api/docker/backups" and self.command == "GET":
                self.write_json({"backups": list_container_backups()})
                return
            if path == "/api/docker/images" and self.command == "GET":
                images = docker.json("GET", "/images/json", query={"all": "0"})
                self.write_json({"images": images})
                return
            if len(parts) == 4 and parts[:3] == ["api", "docker", "backups"]:
                backup_name = urllib.parse.unquote(parts[3])
                if self.command == "POST":
                    self.write_json({"project": restore_container_backup(backup_name, self.compose_roots())})
                    return
            if len(parts) == 5 and parts[:3] == ["api", "docker", "containers"]:
                container_id = urllib.parse.unquote(parts[3])
                action = parts[4]
                if self.command == "POST" and action == "pref":
                    data = self.read_json()
                    key = str(data.get("container_key", container_id)).strip()
                    color = str(data.get("color", "")).strip() or None
                    icon_data = None
                    if data.get("clear_icon"):
                        icon_data = ""
                    elif data.get("icon_content_base64"):
                        icon_data = normalize_container_icon(
                            str(data.get("icon_content_base64", "")),
                            str(data.get("icon_mime", "")),
                        )
                    self.write_json({"pref": STORE.set_container_pref(key, color=color, icon_data=icon_data)})
                    return
                if self.command == "POST" and action == "backup":
                    inspect_data = docker.json("GET", f"/containers/{urllib.parse.quote(container_id, safe='')}/json")
                    backup = create_container_backup(inspect_data)
                    self.write_json({"backup": backup}, status=201)
                    return
                if self.command == "POST" and action == "check-update":
                    inspect_data = docker.json("GET", f"/containers/{urllib.parse.quote(container_id, safe='')}/json")
                    result = check_container_update(inspect_data, docker.socket_path)
                    STORE.set_container_pref(container_key_from_inspect(inspect_data), update_available=bool(result["update_available"]))
                    self.write_json(result)
                    return
                if self.command == "POST" and action == "update":
                    result = update_container_image(docker, container_id)
                    if result.get("ok"):
                        STORE.set_container_pref(result["container_key"], update_available=False)
                    self.write_json(result)
                    return
                if self.command == "GET" and action == "logs":
                    status, data, reason = docker.request(
                        "GET",
                        f"/containers/{urllib.parse.quote(container_id, safe='')}/logs",
                        query={"stdout": "1", "stderr": "1", "timestamps": "1", "tail": "400"},
                        timeout=30,
                    )
                    if status >= 400:
                        raise RuntimeError(data.decode("utf-8", "replace") or reason)
                    self.write_json({"logs": decode_docker_stream(data)})
                    return
                if self.command == "GET" and action == "inspect":
                    self.write_json({"container": docker.json("GET", f"/containers/{urllib.parse.quote(container_id, safe='')}/json")})
                    return
                if self.command == "POST" and action in {"start", "stop", "restart", "kill"}:
                    query = {"t": "10"} if action in {"stop", "restart"} else None
                    status, data, reason = docker.request(
                        "POST",
                        f"/containers/{urllib.parse.quote(container_id, safe='')}/{action}",
                        query=query,
                    )
                    if status not in (200, 204, 304):
                        raise RuntimeError(data.decode("utf-8", "replace") or reason)
                    self.write_json({"ok": True, "status": status})
                    return
                if self.command == "DELETE" and action == "remove":
                    force = self.query_bool("force")
                    status, data, reason = docker.request(
                        "DELETE",
                        f"/containers/{urllib.parse.quote(container_id, safe='')}",
                        query={"force": "1" if force else "0", "v": "0"},
                    )
                    if status not in (200, 204):
                        raise RuntimeError(data.decode("utf-8", "replace") or reason)
                    self.write_json({"ok": True})
                    return
        except Exception as exc:
            self.write_json({"error": str(exc)}, status=502)
            return
        self.write_json({"error": "not found"}, status=404)

    def api_compose(self, path: str, parsed: urllib.parse.ParseResult) -> None:
        try:
            if path == "/api/compose/projects" and self.command == "GET":
                containers = []
                try:
                    containers = self.docker().json("GET", "/containers/json", query={"all": "1", "size": "0"})
                except Exception:
                    containers = []
                self.write_json({"projects": discover_compose_projects(self.compose_roots(), containers)})
                return
            if path == "/api/compose/projects" and self.command == "POST":
                data = self.read_json()
                roots = self.compose_roots()
                if not roots:
                    self.write_json({"error": "no compose roots configured"}, status=400)
                    return
                name = safe_name(str(data.get("name", "stack")), "stack")
                target_dir = roots[0] / name
                target_dir.mkdir(parents=True, exist_ok=False)
                content = str(data.get("content", default_compose_content(name)))
                target_file = target_dir / "compose.yml"
                target_file.write_text(content, encoding="utf-8")
                self.write_json({"project": compose_project_info(target_file)}, status=201)
                return
            if path == "/api/compose/from-command" and self.command == "POST":
                data = self.read_json()
                roots = self.compose_roots()
                if not roots:
                    self.write_json({"error": "no compose roots configured"}, status=400)
                    return
                name = safe_name(str(data.get("name", "command-stack")), "command-stack")
                command = str(data.get("command", "")).strip()
                deploy = bool(data.get("deploy"))
                content = compose_from_docker_run(command, name)
                target_dir = roots[0] / name
                target_dir.mkdir(parents=True, exist_ok=False)
                target_file = target_dir / "compose.yml"
                target_file.write_text(content, encoding="utf-8")
                output = ""
                ok = True
                code = 0
                if deploy:
                    result = run_compose_action(target_file, "up")
                    output = result.get("output", "")
                    ok = bool(result.get("ok"))
                    code = int(result.get("code", 0))
                self.write_json({"ok": ok, "code": code, "output": output, "project": compose_project_info(target_file)}, status=201)
                return
            if path == "/api/compose/file" and self.command == "GET":
                file_path = self.compose_file_from_query(parsed)
                self.write_json({"path": str(file_path), "content": file_path.read_text(encoding="utf-8", errors="replace")})
                return
            if path == "/api/compose/file" and self.command == "PUT":
                data = self.read_json()
                file_path = self.resolve_compose_file(str(data.get("path", "")))
                file_path.write_text(str(data.get("content", "")), encoding="utf-8")
                self.write_json({"ok": True, "project": compose_project_info(file_path)})
                return
            if path == "/api/compose/action" and self.command == "POST":
                data = self.read_json()
                file_path = self.resolve_compose_file(str(data.get("path", "")))
                action = str(data.get("action", "")).strip()
                self.write_json(run_compose_action(file_path, action))
                return
        except FileExistsError:
            self.write_json({"error": "project already exists"}, status=409)
            return
        except Exception as exc:
            self.write_json({"error": str(exc)}, status=400)
            return
        self.write_json({"error": "not found"}, status=404)

    def api_files(self, path: str, parsed: urllib.parse.ParseResult) -> None:
        try:
            if path == "/api/files/roots" and self.command == "GET":
                self.write_json({"roots": self.file_roots_public()})
                return
            if path == "/api/files/list" and self.command == "GET":
                root, target, rel = self.file_target_from_query(parsed)
                self.write_json({"root": root["name"], "path": rel, "items": list_directory(target)})
                return
            if path == "/api/files/read" and self.command == "GET":
                _, target, rel = self.file_target_from_query(parsed)
                if target.stat().st_size > TEXT_PREVIEW_LIMIT:
                    raise ValueError("file is larger than text preview limit")
                self.write_json({"path": rel, "content": target.read_text(encoding="utf-8", errors="replace")})
                return
            if path == "/api/files/download" and self.command == "GET":
                _, target, _ = self.file_target_from_query(parsed)
                self.write_file_download(target)
                return
            if path == "/api/files/write" and self.command == "PUT":
                data = self.read_json()
                _, target, _ = self.resolve_file_target(str(data.get("root", "")), str(data.get("path", "")))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(str(data.get("content", "")), encoding="utf-8")
                self.write_json({"ok": True})
                return
            if path == "/api/files/upload" and self.command == "POST":
                data = self.read_json()
                _, directory, rel = self.resolve_file_target(str(data.get("root", "")), str(data.get("path", "")))
                if not directory.exists() or not directory.is_dir():
                    raise ValueError("upload target must be a directory")
                name = Path(str(data.get("name", ""))).name
                if not name:
                    raise ValueError("file name is required")
                target = (directory / name).resolve()
                self.assert_within_file_root(str(data.get("root", "")), target)
                raw = base64.b64decode(str(data.get("content_base64", "")))
                target.write_bytes(raw)
                self.write_json({"ok": True, "path": str(Path(rel) / name) if rel else name})
                return
            if path == "/api/files/mkdir" and self.command == "POST":
                data = self.read_json()
                _, directory, _ = self.resolve_file_target(str(data.get("root", "")), str(data.get("path", "")))
                name = safe_name(str(data.get("name", "folder")), "folder")
                (directory / name).mkdir(parents=False, exist_ok=False)
                self.write_json({"ok": True})
                return
            if path == "/api/files/rename" and self.command == "POST":
                data = self.read_json()
                root_name = str(data.get("root", ""))
                _, target, _ = self.resolve_file_target(root_name, str(data.get("path", "")))
                new_name = Path(str(data.get("new_name", ""))).name
                if not new_name:
                    raise ValueError("new name is required")
                destination = (target.parent / new_name).resolve()
                self.assert_within_file_root(root_name, destination)
                target.rename(destination)
                self.write_json({"ok": True})
                return
            if path in {"/api/files/copy", "/api/files/move"} and self.command == "POST":
                data = self.read_json()
                root_name = str(data.get("root", ""))
                source_rel = str(data.get("path", "")).strip("/")
                if not source_rel:
                    raise ValueError("refusing to operate on a root directory")
                _, source, _ = self.resolve_file_target(root_name, source_rel)
                destination_root = str(data.get("destination_root", root_name))
                destination_rel = str(data.get("destination_path", "")).strip("/")
                if not destination_rel:
                    raise ValueError("destination path is required")
                _, destination, _ = self.resolve_file_target(destination_root, destination_rel)
                if not source.exists():
                    raise FileNotFoundError("path not found")
                if source.is_dir() and (destination == source or is_relative_to(destination, source)):
                    raise ValueError("cannot move or copy a directory into itself")
                if destination.exists():
                    raise FileExistsError("destination already exists")
                destination.parent.mkdir(parents=True, exist_ok=True)
                if path == "/api/files/copy":
                    if source.is_dir():
                        shutil.copytree(source, destination)
                    else:
                        shutil.copy2(source, destination)
                else:
                    shutil.move(str(source), str(destination))
                self.write_json({"ok": True})
                return
            if path == "/api/files/delete" and self.command == "DELETE":
                query = urllib.parse.parse_qs(parsed.query)
                root_name = query.get("root", [""])[0]
                rel_path = query.get("path", [""])[0]
                if not rel_path.strip("/"):
                    raise ValueError("refusing to delete a root directory")
                _, target, _ = self.resolve_file_target(root_name, rel_path)
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
                self.write_json({"ok": True})
                return
        except Exception as exc:
            self.write_json({"error": str(exc)}, status=400)
            return
        self.write_json({"error": "not found"}, status=404)

    def api_settings(self) -> None:
        if self.command == "GET":
            self.write_json(
                {
                    "docker_socket": STORE.get_setting("docker_socket", DEFAULT_DOCKER_SOCKET),
                    "compose_roots": [str(path) for path in self.compose_roots()],
                    "file_roots": self.file_roots_public(),
                }
            )
            return
        if self.command == "PUT":
            data = self.read_json()
            docker_socket = str(data.get("docker_socket", DEFAULT_DOCKER_SOCKET)).strip() or DEFAULT_DOCKER_SOCKET
            compose_roots = normalize_paths(data.get("compose_roots", []))
            file_roots = normalize_file_roots(data.get("file_roots", []))
            for path_value in compose_roots:
                Path(path_value).expanduser().mkdir(parents=True, exist_ok=True)
            for root in file_roots:
                Path(root["path"]).expanduser().mkdir(parents=True, exist_ok=True)
            STORE.set_setting("docker_socket", docker_socket)
            STORE.set_setting("compose_roots", json_dumps(compose_roots))
            STORE.set_setting("file_roots", json_dumps(file_roots))
            self.write_json({"ok": True})
            return
        self.write_json({"error": "method not allowed"}, status=405)

    def docker(self) -> DockerClient:
        return DockerClient(STORE.get_setting("docker_socket", DEFAULT_DOCKER_SOCKET))

    def compose_roots(self) -> list[Path]:
        values = read_json_setting(STORE.get_setting("compose_roots", "[]"), [])
        return [Path(value).expanduser().resolve() for value in values if str(value).strip()]

    def file_roots(self) -> list[dict[str, Any]]:
        values = read_json_setting(STORE.get_setting("file_roots", "[]"), [])
        return normalize_file_roots(values)

    def file_roots_public(self) -> list[dict[str, str]]:
        return [{"name": root["name"], "path": root["path"]} for root in self.file_roots()]

    def resolve_compose_file(self, value: str) -> Path:
        target = Path(value).expanduser().resolve()
        if target.name not in COMPOSE_FILE_NAMES:
            raise ValueError("not a compose file")
        roots = self.compose_roots()
        if not any(is_relative_to(target, root) for root in roots):
            raise ValueError("compose file is outside configured roots")
        if not target.exists():
            raise FileNotFoundError("compose file not found")
        return target

    def compose_file_from_query(self, parsed: urllib.parse.ParseResult) -> Path:
        query = urllib.parse.parse_qs(parsed.query)
        return self.resolve_compose_file(query.get("path", [""])[0])

    def file_target_from_query(self, parsed: urllib.parse.ParseResult) -> tuple[dict[str, Any], Path, str]:
        query = urllib.parse.parse_qs(parsed.query)
        return self.resolve_file_target(query.get("root", [""])[0], query.get("path", [""])[0])

    def resolve_file_target(self, root_name: str, rel_path: str) -> tuple[dict[str, Any], Path, str]:
        root = next((item for item in self.file_roots() if item["name"] == root_name), None)
        if not root:
            raise ValueError("unknown file root")
        base = Path(root["path"]).expanduser().resolve()
        normalized = rel_path.strip("/")
        target = (base / normalized).resolve()
        if not is_relative_to(target, base):
            raise ValueError("path is outside configured root")
        return root, target, normalized

    def assert_within_file_root(self, root_name: str, target: Path) -> None:
        root = next((item for item in self.file_roots() if item["name"] == root_name), None)
        if not root:
            raise ValueError("unknown file root")
        base = Path(root["path"]).expanduser().resolve()
        if not is_relative_to(target.resolve(), base):
            raise ValueError("path is outside configured root")

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_JSON_BYTES:
            raise ValueError("request body too large")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def write_json(self, payload: Any, status: int = 200, headers: dict[str, str] | None = None) -> None:
        body = json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def write_file_download(self, target: Path) -> None:
        if not target.exists() or not target.is_file():
            raise FileNotFoundError("file not found")
        stat = target.stat()
        safe_filename = target.name.replace('"', "")
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Content-Disposition", f"attachment; filename=\"{safe_filename}\"")
        self.end_headers()
        with target.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile, length=1024 * 1024)

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            target = STATIC_DIR / "index.html"
        else:
            clean = Path(urllib.parse.unquote(path.lstrip("/")))
            target = (STATIC_DIR / clean).resolve()
            if not is_relative_to(target, STATIC_DIR.resolve()) or not target.is_file():
                target = STATIC_DIR / "index.html"
        if not target.exists():
            self.write_json({"error": "static files not found"}, status=404)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-cache" if target.name == "index.html" else "public, max-age=3600")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def cookie_value(self, name: str) -> str | None:
        header = self.headers.get("Cookie")
        if not header:
            return None
        jar = cookies.SimpleCookie()
        jar.load(header)
        morsel = jar.get(name)
        return morsel.value if morsel else None

    def session_cookie(self, token: str) -> str:
        cookie = cookies.SimpleCookie()
        cookie[SESSION_COOKIE] = token
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        cookie[SESSION_COOKIE]["max-age"] = str(SESSION_TTL_SECONDS)
        return cookie.output(header="").strip()

    def expire_cookie(self) -> str:
        cookie = cookies.SimpleCookie()
        cookie[SESSION_COOKIE] = ""
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["max-age"] = "0"
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        return cookie.output(header="").strip()

    def query_bool(self, name: str) -> bool:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        return query.get(name, ["0"])[0].lower() in {"1", "true", "yes", "on"}


COMPOSE_FILE_NAMES = {"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"}


def normalize_paths(values: Any) -> list[str]:
    if isinstance(values, str):
        values = [line.strip() for line in values.splitlines()]
    result: list[str] = []
    for value in values if isinstance(values, list) else []:
        text = str(value).strip()
        if text:
            result.append(str(Path(text).expanduser().resolve()))
    return result


def normalize_file_roots(values: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if isinstance(values, str):
        parsed = []
        for line in values.splitlines():
            if "=" in line:
                name, path = line.split("=", 1)
                parsed.append({"name": name.strip(), "path": path.strip()})
        values = parsed
    for item in values if isinstance(values, list) else []:
        if isinstance(item, dict):
            name = safe_name(str(item.get("name", "")), "root")
            path = str(item.get("path", "")).strip()
            if path:
                result.append({"name": name, "path": str(Path(path).expanduser().resolve())})
    names: set[str] = set()
    unique: list[dict[str, str]] = []
    for item in result:
        name = item["name"]
        if name in names:
            suffix = 2
            while f"{name}-{suffix}" in names:
                suffix += 1
            item = {"name": f"{name}-{suffix}", "path": item["path"]}
        names.add(item["name"])
        unique.append(item)
    return unique


def list_directory(target: Path) -> list[dict[str, Any]]:
    if not target.exists():
        raise FileNotFoundError("path not found")
    if not target.is_dir():
        raise ValueError("path is not a directory")
    items: list[dict[str, Any]] = []
    for child in sorted(target.iterdir(), key=lambda path: (not path.is_dir(), path.name.lower())):
        try:
            stat = child.stat()
        except OSError:
            continue
        items.append(
            {
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "size": stat.st_size,
                "modified": stat.st_mtime,
            }
        )
    return items


def container_key_from_summary(container: dict[str, Any]) -> str:
    names = container.get("Names") or []
    if names:
        return str(names[0]).lstrip("/")
    return str(container.get("Id", ""))[:12]


def container_key_from_inspect(container: dict[str, Any]) -> str:
    name = str(container.get("Name", "")).lstrip("/")
    return name or str(container.get("Id", ""))[:12]


def enrich_containers(containers: list[dict[str, Any]], prefs: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    for container in containers:
        key = container_key_from_summary(container)
        pref = prefs.get(key, {})
        container["DockPilot"] = {
            "key": key,
            "color": pref.get("color", color_from_text(key)),
            "icon_data": pref.get("icon_data", ""),
            "update_available": bool(pref.get("update_available", False)),
            "update_checked_at": pref.get("update_checked_at"),
        }
    return containers


def color_from_text(value: str) -> str:
    palette = ["#2f80ed", "#16a36a", "#7c5cff", "#f08c2e", "#0f766e", "#d946ef", "#ef4444", "#64748b"]
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return palette[digest[0] % len(palette)]


def normalize_container_icon(content_base64: str, mime_type: str) -> str:
    mime = mime_type.strip().lower()
    allowed = {"image/png", "image/jpeg", "image/webp", "image/gif"}
    if mime not in allowed:
        raise ValueError("unsupported icon image type")
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid icon image data") from exc
    if not raw:
        raise ValueError("icon image is empty")
    if len(raw) > 6 * 1024 * 1024:
        raise ValueError("icon image is too large")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def backup_dir() -> Path:
    path = DATA_DIR / "backups" / "containers"
    path.mkdir(parents=True, exist_ok=True)
    return path


def backup_file_path(name: str) -> Path:
    clean = Path(name).name
    if not clean.endswith(".json"):
        clean += ".json"
    target = (backup_dir() / clean).resolve()
    if not is_relative_to(target, backup_dir().resolve()):
        raise ValueError("invalid backup name")
    return target


def list_container_backups() -> list[dict[str, Any]]:
    backups: list[dict[str, Any]] = []
    for path in sorted(backup_dir().glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            stat = path.stat()
            backups.append(
                {
                    "name": path.name,
                    "container_name": data.get("container_name", ""),
                    "image": data.get("image", ""),
                    "created_at": data.get("created_at"),
                    "size": stat.st_size,
                }
            )
        except (OSError, json.JSONDecodeError):
            continue
    return backups


def create_container_backup(inspect_data: dict[str, Any]) -> dict[str, Any]:
    container_name = container_key_from_inspect(inspect_data)
    image = str((inspect_data.get("Config") or {}).get("Image", ""))
    created_at = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    file_name = f"{safe_name(container_name, 'container')}-{created_at}.json"
    content = {
        "version": 1,
        "created_at": created_at,
        "container_name": container_name,
        "image": image,
        "inspect": inspect_data,
        "compose": compose_from_container_inspect(inspect_data),
    }
    path = backup_file_path(file_name)
    path.write_text(json_dumps(content), encoding="utf-8")
    return {"name": path.name, "container_name": container_name, "image": image, "created_at": created_at, "size": path.stat().st_size}


def restore_container_backup(backup_name: str, roots: list[Path]) -> dict[str, Any]:
    if not roots:
        raise ValueError("no compose roots configured")
    path = backup_file_path(backup_name)
    if not path.exists():
        raise FileNotFoundError("backup not found")
    data = json.loads(path.read_text(encoding="utf-8"))
    container_name = safe_name(str(data.get("container_name", "container")), "container")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    target_dir = (roots[0] / f"restore-{container_name}-{stamp}").resolve()
    if not is_relative_to(target_dir, roots[0].resolve()):
        raise ValueError("restore target is outside compose root")
    target_dir.mkdir(parents=True, exist_ok=False)
    target_file = target_dir / "compose.yml"
    target_file.write_text(str(data.get("compose", "")), encoding="utf-8")
    return compose_project_info(target_file)


def quote_yaml(value: Any) -> str:
    text = str(value)
    if text == "":
        return '""'
    if re.fullmatch(r"[A-Za-z0-9_.:/@+-]+", text):
        return text
    return json.dumps(text, ensure_ascii=False)


def compose_from_container_inspect(inspect_data: dict[str, Any]) -> str:
    config = inspect_data.get("Config") or {}
    host_config = inspect_data.get("HostConfig") or {}
    network_settings = inspect_data.get("NetworkSettings") or {}
    name = safe_name(str(inspect_data.get("Name", "")).lstrip("/") or "container", "container")
    service_name = safe_name(name, "service")
    lines = ["services:", f"  {service_name}:", f"    image: {quote_yaml(config.get('Image', ''))}", f"    container_name: {quote_yaml(service_name + '-restored')}"]
    restart = (host_config.get("RestartPolicy") or {}).get("Name")
    if restart and restart != "no":
        lines.append(f"    restart: {quote_yaml(restart)}")
    env = config.get("Env") or []
    if env:
        lines.append("    environment:")
        for item in env:
            lines.append(f"      - {quote_yaml(item)}")
    ports = network_settings.get("Ports") or {}
    port_lines: list[str] = []
    for container_port, bindings in ports.items():
        for binding in bindings or []:
            host_port = binding.get("HostPort")
            if host_port:
                port_lines.append(f"{host_port}:{container_port}")
    if port_lines:
        lines.append("    ports:")
        for item in sorted(port_lines):
            lines.append(f"      - {quote_yaml(item)}")
    mounts = inspect_data.get("Mounts") or []
    volume_lines: list[str] = []
    for mount in mounts:
        source = mount.get("Source") or mount.get("Name")
        destination = mount.get("Destination")
        if source and destination:
            suffix = ":ro" if not mount.get("RW", True) else ""
            volume_lines.append(f"{source}:{destination}{suffix}")
    if volume_lines:
        lines.append("    volumes:")
        for item in sorted(volume_lines):
            lines.append(f"      - {quote_yaml(item)}")
    networks = (network_settings.get("Networks") or {}).keys()
    network_list = [name for name in networks if name and name != "bridge"]
    if network_list:
        lines.append("    networks:")
        for network in network_list:
            lines.append(f"      - {quote_yaml(network)}")
        lines.append("networks:")
        for network in network_list:
            lines.append(f"  {quote_yaml(network)}:")
            lines.append("    external: true")
    return "\n".join(lines) + "\n"


def docker_cli_env(socket_path: str | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if socket_path:
        env["DOCKER_HOST"] = f"unix://{socket_path}"
    return env


def run_docker_cli(args: list[str], socket_path: str | None = None, timeout: int = 300, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        cwd=str(cwd) if cwd else None,
        env=docker_cli_env(socket_path),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def check_container_update(inspect_data: dict[str, Any], socket_path: str | None = None) -> dict[str, Any]:
    image = str((inspect_data.get("Config") or {}).get("Image", "")).strip()
    if not image or image.startswith("sha256:"):
        return {"ok": False, "update_available": False, "message": "image name is not checkable"}
    container_image_id = str(inspect_data.get("Image", "")).strip()
    try:
        before = run_docker_cli(["image", "inspect", image, "--format", "{{.Id}}"], socket_path, timeout=30)
        pull = run_docker_cli(["pull", image], socket_path, timeout=600)
        after = run_docker_cli(["image", "inspect", image, "--format", "{{.Id}}"], socket_path, timeout=30)
    except FileNotFoundError:
        return {"ok": False, "update_available": False, "message": "docker CLI not found in PATH"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "update_available": False, "message": "update check timed out"}
    if pull.returncode != 0:
        return {"ok": False, "update_available": False, "message": pull.stdout.strip() or "docker pull failed"}
    if after.returncode != 0:
        return {"ok": False, "update_available": False, "message": after.stdout.strip()}
    before_id = before.stdout.strip() if before.returncode == 0 else ""
    latest_id = after.stdout.strip()
    update_available = bool(container_image_id and latest_id and normalize_image_id(container_image_id) != normalize_image_id(latest_id))
    return {
        "ok": True,
        "image": image,
        "update_available": update_available,
        "container_image_id": container_image_id,
        "previous_local_image_id": before_id,
        "latest_image_id": latest_id,
        "pull_output": pull.stdout,
    }


def normalize_image_id(value: str) -> str:
    text = value.strip()
    return text[7:] if text.startswith("sha256:") else text


def update_container_image(docker: DockerClient, container_id: str) -> dict[str, Any]:
    inspect_data = docker.json("GET", f"/containers/{urllib.parse.quote(container_id, safe='')}/json")
    container_key = container_key_from_inspect(inspect_data)
    image = str((inspect_data.get("Config") or {}).get("Image", "")).strip()
    if not image or image.startswith("sha256:"):
        raise ValueError("image name is not checkable")
    backup = create_container_backup(inspect_data)
    compose_result = update_compose_managed_container(inspect_data, docker.socket_path)
    if compose_result:
        compose_result.update({"container_key": container_key, "backup": backup})
        return compose_result
    try:
        pull = run_docker_cli(["pull", image], docker.socket_path, timeout=600)
    except FileNotFoundError:
        return {
            "ok": False,
            "container_key": container_key,
            "backup": backup,
            "method": "standalone",
            "output": "",
            "message": "docker CLI not found in PATH",
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "container_key": container_key,
            "backup": backup,
            "method": "standalone",
            "output": str(exc.stdout or ""),
            "message": "container update timed out",
        }
    if pull.returncode != 0:
        return {
            "ok": False,
            "container_key": container_key,
            "backup": backup,
            "method": "standalone",
            "output": pull.stdout,
            "message": "docker pull failed",
        }
    result = recreate_standalone_container(docker, inspect_data)
    result.update({"container_key": container_key, "backup": backup, "pull_output": pull.stdout})
    return result


def update_compose_managed_container(inspect_data: dict[str, Any], socket_path: str | None = None) -> dict[str, Any] | None:
    config = inspect_data.get("Config") or {}
    labels = config.get("Labels") or {}
    service = str(labels.get("com.docker.compose.service", "")).strip()
    config_files = str(labels.get("com.docker.compose.project.config_files", "")).strip()
    if not service or not config_files:
        return None
    compose_file = Path(config_files.split(",", 1)[0]).expanduser()
    if not compose_file.exists():
        return None
    working_dir = Path(str(labels.get("com.docker.compose.project.working_dir", ""))).expanduser()
    cwd = working_dir if str(working_dir) != "." and working_dir.exists() else compose_file.parent
    try:
        pull = run_docker_cli(["compose", "-f", str(compose_file), "pull", service], socket_path, timeout=600, cwd=cwd)
        if pull.returncode != 0:
            return {
                "ok": False,
                "method": "compose",
                "output": pull.stdout,
                "message": "docker compose pull failed",
            }
        up = run_docker_cli(
            ["compose", "-f", str(compose_file), "up", "-d", "--force-recreate", service],
            socket_path,
            timeout=600,
            cwd=cwd,
        )
    except FileNotFoundError:
        return {"ok": False, "method": "compose", "output": "", "message": "docker CLI not found in PATH"}
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "method": "compose", "output": str(exc.stdout or ""), "message": "container update timed out"}
    return {
        "ok": up.returncode == 0,
        "method": "compose",
        "output": pull.stdout + "\n" + up.stdout,
        "message": "updated" if up.returncode == 0 else "docker compose up failed",
    }


def recreate_standalone_container(docker: DockerClient, inspect_data: dict[str, Any]) -> dict[str, Any]:
    container_id = str(inspect_data.get("Id", ""))
    original_name = container_key_from_inspect(inspect_data)
    backup_name = safe_name(f"{original_name}-old-{time.strftime('%Y%m%d-%H%M%S')}-{container_id[:8]}", "old-container")
    was_running = bool((inspect_data.get("State") or {}).get("Running"))
    new_id = ""
    try:
        if was_running:
            status, data, reason = docker.request(
                "POST",
                f"/containers/{urllib.parse.quote(container_id, safe='')}/stop",
                query={"t": "30"},
                timeout=40,
            )
            if status not in (200, 204, 304):
                raise RuntimeError(data.decode("utf-8", "replace") or reason)
        status, data, reason = docker.request(
            "POST",
            f"/containers/{urllib.parse.quote(container_id, safe='')}/rename",
            query={"name": backup_name},
        )
        if status not in (200, 204):
            raise RuntimeError(data.decode("utf-8", "replace") or reason)
        create_body = container_create_body_from_inspect(inspect_data)
        created = docker.json("POST", "/containers/create", query={"name": original_name}, body=create_body)
        new_id = str(created.get("Id", ""))
        if was_running:
            status, data, reason = docker.request("POST", f"/containers/{urllib.parse.quote(new_id, safe='')}/start")
            if status not in (200, 204, 304):
                raise RuntimeError(data.decode("utf-8", "replace") or reason)
        status, _, _ = docker.request(
            "DELETE",
            f"/containers/{urllib.parse.quote(container_id, safe='')}",
            query={"force": "0", "v": "0"},
        )
        return {
            "ok": True,
            "method": "standalone",
            "message": "updated",
            "old_container": backup_name if status not in (200, 204) else "",
            "new_container_id": new_id,
        }
    except Exception:
        rollback_standalone_update(docker, original_name, backup_name, new_id, was_running)
        raise


def rollback_standalone_update(docker: DockerClient, original_name: str, backup_name: str, new_id: str, was_running: bool) -> None:
    if new_id:
        try:
            docker.request("DELETE", f"/containers/{urllib.parse.quote(new_id, safe='')}", query={"force": "1", "v": "0"})
        except Exception:
            pass
    try:
        docker.request("POST", f"/containers/{urllib.parse.quote(backup_name, safe='')}/rename", query={"name": original_name})
    except Exception:
        pass
    if was_running:
        try:
            docker.request("POST", f"/containers/{urllib.parse.quote(original_name, safe='')}/start")
        except Exception:
            pass


def container_create_body_from_inspect(inspect_data: dict[str, Any]) -> dict[str, Any]:
    config = dict(inspect_data.get("Config") or {})
    host_config = dict(inspect_data.get("HostConfig") or {})
    networking_config = networking_config_from_inspect(inspect_data)
    body: dict[str, Any] = {
        **config,
        "HostConfig": host_config,
    }
    if networking_config:
        body["NetworkingConfig"] = networking_config
    return body


def networking_config_from_inspect(inspect_data: dict[str, Any]) -> dict[str, Any]:
    network_settings = inspect_data.get("NetworkSettings") or {}
    networks = network_settings.get("Networks") or {}
    endpoints: dict[str, Any] = {}
    for network_name, network in networks.items():
        endpoint: dict[str, Any] = {}
        aliases = [
            str(alias)
            for alias in network.get("Aliases") or []
            if alias and str(alias) != str(inspect_data.get("Id", ""))[:12]
        ]
        if aliases:
            endpoint["Aliases"] = aliases
        endpoints[str(network_name)] = endpoint
    return {"EndpointsConfig": endpoints} if endpoints else {}


def compose_from_docker_run(command: str, project_name: str) -> str:
    tokens = shlex.split(command)
    if not tokens:
        raise ValueError("command is required")
    if tokens and tokens[0] == "sudo":
        tokens = tokens[1:]
    if tokens[:2] == ["docker", "run"]:
        tokens = tokens[2:]
    elif tokens[:3] == ["docker", "container", "run"]:
        tokens = tokens[3:]
    else:
        raise ValueError("command must start with docker run")
    service_name = safe_name(project_name, "app")
    container_name = service_name
    image = ""
    command_parts: list[str] = []
    ports: list[str] = []
    volumes: list[str] = []
    environment: list[str] = []
    restart = ""
    network = ""
    hostname = ""
    user = ""
    workdir = ""
    entrypoint = ""
    add_hosts: list[str] = []
    cap_add: list[str] = []
    devices: list[str] = []
    dns: list[str] = []
    privileged = False
    init = False
    tty = False
    stdin_open = False
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in {"-d", "--detach", "--rm"}:
            i += 1
            continue
        if token in {"-i", "--interactive"}:
            stdin_open = True
            i += 1
            continue
        if token in {"-t", "--tty"}:
            tty = True
            i += 1
            continue
        if token == "--privileged":
            privileged = True
            i += 1
            continue
        if token == "--init":
            init = True
            i += 1
            continue
        if token.startswith("--name="):
            container_name = safe_name(token.split("=", 1)[1], service_name)
            i += 1
            continue
        if token == "--name":
            container_name = safe_name(tokens[i + 1], service_name)
            i += 2
            continue
        if token in {"-p", "--publish"}:
            ports.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("-p") and token != "-p":
            ports.append(token[2:])
            i += 1
            continue
        if token in {"-v", "--volume"}:
            volumes.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("-v") and token != "-v":
            volumes.append(token[2:])
            i += 1
            continue
        if token in {"-e", "--env"}:
            environment.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("-e") and token != "-e":
            environment.append(token[2:])
            i += 1
            continue
        if token == "--restart":
            restart = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--restart="):
            restart = token.split("=", 1)[1]
            i += 1
            continue
        if token == "--network":
            network = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--network="):
            network = token.split("=", 1)[1]
            i += 1
            continue
        if token == "--hostname":
            hostname = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--hostname="):
            hostname = token.split("=", 1)[1]
            i += 1
            continue
        if token in {"-u", "--user"}:
            user = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--user="):
            user = token.split("=", 1)[1]
            i += 1
            continue
        if token in {"-w", "--workdir"}:
            workdir = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--workdir="):
            workdir = token.split("=", 1)[1]
            i += 1
            continue
        if token == "--entrypoint":
            entrypoint = tokens[i + 1]
            i += 2
            continue
        if token.startswith("--entrypoint="):
            entrypoint = token.split("=", 1)[1]
            i += 1
            continue
        if token == "--add-host":
            add_hosts.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("--add-host="):
            add_hosts.append(token.split("=", 1)[1])
            i += 1
            continue
        if token == "--cap-add":
            cap_add.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("--cap-add="):
            cap_add.append(token.split("=", 1)[1])
            i += 1
            continue
        if token == "--device":
            devices.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("--device="):
            devices.append(token.split("=", 1)[1])
            i += 1
            continue
        if token == "--dns":
            dns.append(tokens[i + 1])
            i += 2
            continue
        if token.startswith("--dns="):
            dns.append(token.split("=", 1)[1])
            i += 1
            continue
        if token in {"--pull", "--platform", "--env-file", "--label", "--log-driver", "--log-opt", "--cpus", "--memory", "--memory-swap"}:
            i += 2
            continue
        if any(token.startswith(prefix + "=") for prefix in {"--pull", "--platform", "--env-file", "--label", "--log-driver", "--log-opt", "--cpus", "--memory", "--memory-swap"}):
            i += 1
            continue
        if token == "--":
            command_parts = tokens[i + 1 :]
            break
        if token.startswith("-"):
            i += 1
            continue
        image = token
        command_parts = tokens[i + 1 :]
        break
    if not image:
        raise ValueError("docker image is required")
    lines = ["services:", f"  {service_name}:", f"    image: {quote_yaml(image)}", f"    container_name: {quote_yaml(container_name)}"]
    if restart and restart != "no":
        lines.append(f"    restart: {quote_yaml(restart)}")
    if ports:
        lines.append("    ports:")
        for item in ports:
            lines.append(f"      - {quote_yaml(item)}")
    if volumes:
        lines.append("    volumes:")
        for item in volumes:
            lines.append(f"      - {quote_yaml(item)}")
    if environment:
        lines.append("    environment:")
        for item in environment:
            lines.append(f"      - {quote_yaml(item)}")
    if hostname:
        lines.append(f"    hostname: {quote_yaml(hostname)}")
    if user:
        lines.append(f"    user: {quote_yaml(user)}")
    if workdir:
        lines.append(f"    working_dir: {quote_yaml(workdir)}")
    if entrypoint:
        lines.append(f"    entrypoint: {quote_yaml(entrypoint)}")
    if command_parts:
        lines.append("    command:")
        for item in command_parts:
            lines.append(f"      - {quote_yaml(item)}")
    if add_hosts:
        lines.append("    extra_hosts:")
        for item in add_hosts:
            lines.append(f"      - {quote_yaml(item)}")
    if cap_add:
        lines.append("    cap_add:")
        for item in cap_add:
            lines.append(f"      - {quote_yaml(item)}")
    if devices:
        lines.append("    devices:")
        for item in devices:
            lines.append(f"      - {quote_yaml(item)}")
    if dns:
        lines.append("    dns:")
        for item in dns:
            lines.append(f"      - {quote_yaml(item)}")
    if privileged:
        lines.append("    privileged: true")
    if init:
        lines.append("    init: true")
    if tty:
        lines.append("    tty: true")
    if stdin_open:
        lines.append("    stdin_open: true")
    if network and network not in {"bridge", "host", "none"}:
        lines.append("    networks:")
        lines.append(f"      - {quote_yaml(network)}")
        lines.append("networks:")
        lines.append(f"  {quote_yaml(network)}:")
        lines.append("    external: true")
    elif network in {"host", "none"}:
        lines.append(f"    network_mode: {quote_yaml(network)}")
    return "\n".join(lines) + "\n"


def discover_compose_projects(roots: list[Path], containers: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    seen: set[Path] = set()
    containers = containers or []
    for root in roots:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            current = Path(dirpath)
            depth = len(current.relative_to(root).parts)
            if depth > 4:
                dirnames[:] = []
                continue
            dirnames[:] = [name for name in dirnames if not name.startswith(".") and name not in {"node_modules", "__pycache__"}]
            for name in sorted(COMPOSE_FILE_NAMES):
                if name in filenames:
                    compose_file = (current / name).resolve()
                    if compose_file not in seen:
                        seen.add(compose_file)
                        projects.append(compose_project_info(compose_file, containers))
                    break
    projects.sort(key=lambda item: item["name"].lower())
    return projects


def compose_project_info(compose_file: Path, containers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    content = compose_file.read_text(encoding="utf-8", errors="replace") if compose_file.exists() else ""
    services = parse_compose_services(content)
    return {
        "name": compose_file.parent.name,
        "path": str(compose_file),
        "directory": str(compose_file.parent),
        "file": compose_file.name,
        "services": services,
        "containers": compose_service_statuses(compose_file, services, containers or []),
        "modified": compose_file.stat().st_mtime if compose_file.exists() else None,
    }


def compose_service_statuses(compose_file: Path, services: list[str], containers: list[dict[str, Any]]) -> list[dict[str, str]]:
    by_service: dict[str, dict[str, str]] = {}
    compose_file_text = str(compose_file.resolve())
    compose_dir = str(compose_file.parent.resolve())
    for container in containers:
        labels = container.get("Labels") or {}
        if not isinstance(labels, dict):
            labels = {}
        service = str(labels.get("com.docker.compose.service", "")).strip()
        config_files = [
            str(Path(item.strip()).expanduser().resolve())
            for item in str(labels.get("com.docker.compose.project.config_files", "")).split(",")
            if item.strip()
        ]
        working_dir = str(labels.get("com.docker.compose.project.working_dir", "")).strip()
        same_file = compose_file_text in config_files
        same_dir = bool(working_dir) and str(Path(working_dir).expanduser().resolve()) == compose_dir
        if not service or (not same_file and not same_dir):
            continue
        by_service[service] = {
            "service": service,
            "name": container_key_from_summary(container),
            "state": str(container.get("State", "")),
            "status": str(container.get("Status", "")),
            "id": str(container.get("Id", "")),
        }
    result: list[dict[str, str]] = []
    for service in services:
        result.append(
            by_service.get(
                service,
                {"service": service, "name": "", "state": "missing", "status": "未部署", "id": ""},
            )
        )
    for service, item in by_service.items():
        if service not in services:
            result.append(item)
    return result


def parse_compose_services(content: str) -> list[str]:
    services: list[str] = []
    in_services = False
    base_indent = 0
    service_indent: int | None = None
    for line in content.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if stripped == "services:":
            in_services = True
            base_indent = indent
            service_indent = None
            continue
        if in_services:
            if indent <= base_indent:
                break
            match = re.match(r"^\s*([A-Za-z0-9_.-]+):\s*(?:#.*)?$", line)
            if match and service_indent is None:
                service_indent = indent
            if match and indent == service_indent:
                name = match.group(1)
                if not name.startswith("x-") and name not in services:
                    services.append(name)
    return services


def default_compose_content(name: str) -> str:
    service_name = safe_name(name, "app")
    return f"""services:
  {service_name}:
    image: nginx:alpine
    container_name: {service_name}
    restart: unless-stopped
    ports:
      - "8080:80"
"""


def run_compose_action(file_path: Path, action: str) -> dict[str, Any]:
    actions = {
        "up": ["up", "-d"],
        "down": ["down"],
        "restart": ["restart"],
        "pull": ["pull"],
        "ps": ["ps"],
        "logs": ["logs", "--tail", "200"],
        "config": ["config"],
    }
    if action not in actions:
        raise ValueError("unsupported compose action")
    cmd = ["docker", "compose", "-f", str(file_path), *actions[action]]
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(file_path.parent),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=240,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("docker CLI not found in PATH") from exc
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") + "\nCommand timed out."
        return {"ok": False, "code": 124, "output": output, "command": " ".join(cmd)}
    return {"ok": completed.returncode == 0, "code": completed.returncode, "output": completed.stdout, "command": " ".join(cmd)}


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="DockPilot private Docker/NAS management panel")
    parser.add_argument("--host", default=os.environ.get("DOCKPILOT_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DOCKPILOT_PORT", "8088")))
    args = parser.parse_args()

    STORE.init()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"DockPilot listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

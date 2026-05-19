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
        assert_true("app.js?v=20260519-65" in page, "首页应引用新的前端资源版本，避免浏览器缓存旧 app.js")
        assert_true("styles.css?v=20260519-65" in page, "首页应引用新的样式资源版本，避免浏览器缓存旧 styles.css")
        assert_true("/vendor/codemirror/codemirror.min.js" in page, "首页应加载本地 CodeMirror 编辑器")
        assert_true("/vendor/codemirror/yaml.min.js" in page, "首页应加载本地 CodeMirror YAML 高亮模式")
        assert_true("/vendor/codemirror/codemirror.bundle.mjs" not in page, "首页不应加载会造成扩展实例不一致的 CM6 bundle")
        assert_true("/vendor/codemirror/lang-yaml.bundle.mjs" not in page, "首页不应加载会重复打包 @codemirror/state 的独立 YAML bundle")
        assert_true("/vendor/codemirror/state.bundle.mjs" not in page, "首页不应加载会造成 CodeMirror 多实例的独立 state bundle")
        assert_true("https://esm.sh" not in page, "CodeMirror 不应依赖外网 CDN")
        _, app_js = client.request("GET", "/app.js")
        server_py = (ROOT / "dockpilot" / "server.py").read_text(encoding="utf-8")
        _, cm_bundle = client.request("GET", "/vendor/codemirror/codemirror.min.js")
        _, cm_yaml = client.request("GET", "/vendor/codemirror/yaml.min.js")
        assert_true("CodeMirror" in cm_bundle and "fromTextArea" in cm_bundle, "本地 CodeMirror 编辑器应可访问")
        assert_true("yaml" in cm_yaml.lower(), "本地 CodeMirror YAML 高亮模式应可访问")
        assert_true("首页导航" in app_js, "前端脚本应为中文界面")
        assert_true("update-job" in app_js, "容器更新应使用后台任务接口")
        assert_true("containerUpdateJobs" in app_js, "容器更新任务应按容器分别跟踪")
        assert_true("renderContainerUpdateConfirm" in app_js, "容器一键更新应使用自定义确认弹窗")
        assert_true("更新容器？" in app_js, "容器更新确认弹窗应使用简洁标题")
        assert_true("scheduleContainerUpdateChecks" in app_js, "容器页应自动调度更新检测")
        assert_true("60 * 60" in app_js, "容器自动更新检测间隔应为 1 小时")
        assert_true('state.tab === "containers") checkContainerUpdates' in app_js, "自动更新检测执行前应确认仍停留在容器页")
        assert_true("renderContainerCardUpdateProgress" in app_js, "更新进度应显示在对应容器卡片上")
        assert_true("touch_update_checked_at=True" in server_py, "更新检测失败也应记录尝试时间，避免每次打开容器页重复检测")
        assert_true("update_check_error" in app_js, "更新检测失败时不应静默覆盖更新状态")
        assert_true("containerImageName" in app_js, "容器卡片应优先显示解析后的镜像名")
        assert_true("镜像库" in app_js, "前端应包含镜像库页面")
        assert_true("Docker 卷" in app_js, "前端应包含 Docker 卷页面")
        assert_true("volume-backup" in app_js, "Docker 卷应支持备份")
        assert_true("volume-prune" in app_js, "Docker 卷应支持清理未使用卷")
        assert_true("volumeCreateForm" in app_js, "Docker 卷应支持新增卷")
        assert_true("volume-detail" in app_js, "Docker 卷应支持详情")
        assert_true("bulk-backup" in app_js, "Docker 卷应支持批量备份")
        assert_true("restore-replace" in app_js, "Docker 卷应支持覆盖恢复入口")
        assert_true("imagePullForm" in app_js, "镜像库应支持拉取镜像")
        assert_true("imageRemoteSearchForm" in app_js, "镜像库应支持远程搜索镜像")
        assert_true("pull_mode" in app_js, "镜像库拉取镜像应可选择下载方式")
        assert_true("imagePullJob" in app_js, "镜像拉取应使用带进度的后台任务")
        assert_true("scheduleImageProxyTest" in app_js, "镜像代理应自动连通检测")
        assert_true("proxyStatusText" in app_js, "镜像代理连通性应显示明确状态文案")
        assert_true("image-usage" in app_js, "镜像库应区分已使用和未使用镜像")
        assert_true("registry_mirrors" in app_js, "镜像库应支持多个镜像加速源")
        assert_true("compose-repair" in app_js, "Compose 编辑器应支持 AI 修正")
        assert_true("compose-convert-command-ai" in app_js, "Compose 编辑器应支持 AI 转 Compose")
        assert_true("转 Compose" in app_js, "Compose 转换按钮应显示明确文案")
        assert_true("compose-apply-ai" in app_js, "Compose 编辑器应先预览再应用 AI 修正")
        assert_true("应用到编辑器" in app_js, "Compose AI 修复应用按钮应明确只写入编辑器")
        assert_true("compose-save-repair-instruction" in app_js, "Compose AI 修正要求应单独保存")
        assert_true("compose-reference-shell" in app_js, "Compose 页面应使用参考图四栏工作台外壳")
        assert_true("compose-ai-issue-card" in app_js, "Compose AI 预览应使用问题卡片")
        assert_true("compose-log-panel" in app_js, "Compose 右侧面板应显示容器日志")
        assert_true("compose-copy-logs" in app_js, "Compose 容器日志应支持复制")
        assert_true("state.compose.logs" in app_js, "Compose 容器日志应与命令输出分离")
        assert_true("compose-workspace-shell" in app_js, "Compose 编辑器、AI 和日志应合并在一个工作台窗口内")
        assert_true("busyAction" in app_js, "Compose 操作按钮应有忙碌状态，避免重复点击")
        assert_true("compose-ai-status" in app_js, "Compose AI 修正应显示交互状态")
        assert_true("composeRepairInstruction" in app_js, "Compose AI 修正要求应支持自定义编辑")
        assert_true("repairInstruction" in app_js, "Compose AI 修正请求应携带自定义要求")
        assert_true("compose-editor-statusbar" in app_js, "Compose 编辑器应提供底部状态栏")
        assert_true("DockPilotCodeMirror" in app_js, "Compose 编辑器应挂载 CodeMirror")
        assert_true("composeEditorValue" in app_js, "Compose 操作应从 CodeMirror 读取当前内容")
        assert_true("compose-editor-titlebar" in app_js, "Compose 编辑器顶部应显示 compose 文件名")
        assert_true("icons.compose" not in app_js, "Compose 项目卡片不应引用局部作用域外的 icons 变量")
        assert_true("composeStatusLabel(tone)" in app_js, "Compose 项目列表应显示状态而不是路径")
        assert_true("compose-project-state" in app_js, "Compose 项目列表应使用紧凑状态行")
        assert_true("compose.yml</small>" not in app_js, "Compose 项目列表不应显示重复副信息")
        assert_true("selectCompose(state.compose.projects[0].path)" in app_js, "Compose 页面进入后应自动选中第一个项目")
        assert_true("compose-ai-preview-code" in app_js, "Compose AI 预览代码块应使用隔离样式")
        assert_true("API_TIMEOUT_MS" in app_js, "前端 API 请求应有超时保护，避免页面一直加载")
        assert_true("compose_ai_base_url" in app_js, "系统设置应支持 AI 兼容接口地址")
        assert_true("compose_ai_model" in app_js, "系统设置应支持配置 AI 模型")
        assert_true("settings-side-nav" in app_js, "系统设置页应提供左侧分类导航")
        assert_true("settings-tab" in app_js, "系统设置页应点击分类后只显示当前层级")
        assert_true("settings-single-card" in app_js, "系统设置页应收敛为单一卡片")
        assert_true("settings-section-card" in app_js, "系统设置页应使用分组设置卡片")
        assert_true("container-backups-clear" in app_js, "容器备份应支持一键清理")
        assert_true("container-backup-delete" in app_js, "容器备份应支持删除")
        assert_true("nav-minimal-board" in app_js, "首页导航应使用隔离的极简分组书签板")
        assert_true("navSettingsForm" in app_js, "首页导航应支持外观设置")
        assert_true("nav-group-collapse" in app_js, "首页导航分组应支持折叠")
        assert_true("navSearch" in app_js, "首页导航应支持搜索")
        assert_true("webSearchForm" in app_js, "导航页顶部应提供网页搜索框")
        assert_true("web_search_engine" in app_js, "导航页应支持切换网页搜索引擎")
        assert_true("section_title" in app_js, "导航页应用区标题应支持自定义")
        assert_true("nav-minimal-section-title" not in app_js, "电脑版首页导航应移除顶部应用区标题装饰")
        assert_true("分类书签" not in app_js, "导航页不应再固定显示分类书签文案")
        assert_true("dashboardWidgetForm" not in app_js, "导航页内容应移除状态小卡片")
        assert_true("renderDashboardWidgets()" not in app_js, "导航页不应渲染状态模块")
        assert_true("card-icon-auto" in app_js, "书签图标应支持自动匹配")
        assert_true("icon-library-grid" in app_js, "书签图标应提供图标库")
        assert_true("icon_size" in app_js, "书签图标应支持大小调节")
        assert_true("title_font_size" in app_js, "书签标题字体应支持大小调节")
        assert_true("bookmark-context-menu" in app_js, "书签卡片应支持右键菜单")
        assert_true("${renderCardContextMenu()}" in app_js, "书签右键菜单应在应用根层渲染，避免被首页画布布局影响")
        assert_true("${renderCardModal()}" in app_js, "书签编辑弹窗应在应用根层渲染，避免被首页画布布局影响")
        assert_true("${renderNavSettingsModal()}" in app_js, "首页导航设置弹窗应在应用根层渲染，避免被首页画布布局影响")
        assert_true("contextMenuPositionForPoint" in app_js, "书签右键菜单应从点击位置弹出")
        assert_true("event.clientX" in app_js and "event.clientY" in app_js, "书签右键菜单定位应使用右击坐标")
        assert_true("openCardContextMenuFromNode" in app_js, "书签右键菜单应有统一打开逻辑")
        assert_true("pointerdown" in app_js, "书签右键菜单应兼容真实鼠标右键事件")
        assert_true("if (state.cardContextMenu.open) return" in app_js, "书签右键菜单打开后不应被二次右键事件覆盖坐标")
        assert_true("cardIconUpload" in app_js, "书签卡片应支持图标上传")
        assert_true("cardModal" in app_js, "书签卡片应使用弹窗添加和编辑")
        assert_true("bookmark-editor-modal" in app_js, "书签编辑窗口应使用独立弹窗样式")
        assert_true("navGroupForm" in app_js, "首页导航分组应使用独立设置弹窗")
        assert_true("shape-" in app_js, "书签卡片应支持形状自定义")
        assert_true("icon_shape" in app_js, "书签图标应支持形状自定义")
        assert_true("layout responsive-baseline" in app_js, "应用根布局应启用全局响应式基线")
        assert_true("nav-workbench-command" in app_js, "首页导航应提供工作台顶部标题和全局操作区")
        assert_true("nav-workbench-library-head" in app_js, "首页导航应区分书签库标题和书签过滤")
        assert_true("nav-workbench-group" in app_js, "首页导航分组应使用清晰的工作台层级")
        assert_true("nav-workbench-centered" in app_js, "首页导航顶部标题和搜索区域应视觉居中")
        assert_true("nav-workbench-group-tools" in app_js, "首页导航分组操作应收敛为少量入口")
        assert_true('data-action="nav-group-color" data-group' not in app_js, "首页导航分组不应常驻显示颜色按钮")
        _, styles_css = client.request("GET", "/styles.css")
        assert_true("container-card-update-progress" in styles_css, "容器更新应提供卡片内进度条样式")
        assert_true("repeat(4, minmax(0, 1fr))" in styles_css, "桌面端容器卡片应为四列紧凑布局")
        assert_true("min-height: 102px" in styles_css, "容器卡片高度应压缩为紧凑尺寸")
        assert_true("min-height: 28px" in styles_css, "容器操作按钮应使用紧凑高度")
        assert_true("image-search-results" in styles_css, "镜像库应提供搜索结果样式")
        assert_true("image-tool-card" in styles_css, "镜像库功能区应使用分区卡片")
        assert_true("image-pull-progress" in styles_css, "镜像拉取应提供进度条样式")
        assert_true("image-group-section" in app_js, "镜像库本地镜像应按状态分组展示")
        assert_true("image-status-dot" in app_js, "镜像卡片应提供状态圆点")
        assert_true("image-card-shell" in styles_css, "镜像库卡片应使用专业化卡片壳层")
        assert_true("image-card-actions" in styles_css, "镜像库卡片操作区应紧凑收敛")
        assert_true("volume-table-row" in styles_css, "Docker 卷应使用紧凑列表行模式")
        assert_true("volume-summary-bar" in app_js, "Docker 卷应提供镜像库模式的统计条")
        assert_true("volume-detail-modal" in styles_css, "Docker 卷详情应使用弹窗")
        assert_true("volume-risk" in styles_css, "Docker 卷应提供风险标识")
        assert_true("backup-actions" in styles_css, "容器备份应提供恢复和删除操作样式")
        assert_true("nav-minimal-card" in styles_css, "书签卡片应提供隔离的极简玻璃样式")
        assert_true("nav-reference-board" in app_js, "首页导航应使用参考图式分组导航结构")
        assert_true("nav-reference-group" in app_js, "首页导航分组应拥有独立标题和操作区")
        assert_true("nav-reference-group .nav-minimal-card" in styles_css, "首页导航卡片应使用参考图式高密度白色入口")
        assert_true("nav-workbench-command" in styles_css, "首页导航应使用浅色工作台顶部布局")
        assert_true("min-width: 721px" in styles_css, "桌面端首页导航应使用独立宽屏布局规则")
        assert_true("justify-self: stretch" in styles_css, "首页导航书签区域应铺满主内容宽度")
        assert_true("min-height: 78px" in styles_css, "首页导航卡片应保持高密度显示，避免减少同屏内容")
        assert_true("min-height: 72px" in styles_css, "手机端首页导航卡片应保留足够高度，避免比其他页面卡片明显偏短")
        assert_true("nav-minimal-search" in styles_css, "导航页应提供隔离的透明玻璃搜索样式")
        assert_true("nav-minimal-settings" in styles_css, "导航页右上角设置入口应默认隐藏")
        assert_true(".settings-single-card" in styles_css, "系统设置页应使用单一卡片布局")
        assert_true(".settings-section-card input" in styles_css, "系统设置页输入框规格应统一")
        assert_true("icon-library-grid" in styles_css, "书签图标库应提供网格样式")
        assert_true(".bookmark-editor-modal .card-modal-foot" in styles_css, "书签编辑窗口应提供参考图式底部操作栏")
        assert_true("width: 248px" in styles_css and "right: auto" in styles_css and "bottom: auto" in styles_css, "书签右键菜单应被锁定为小浮窗")
        assert_true(".bookmark-editor-modal .card-modal-grid .wide" in styles_css, "书签编辑窗口主输入项应独占整行，避免链接输入框被挤窄")
        assert_true("nav-group-editor-modal" in styles_css, "首页导航分组设置应提供独立弹窗样式")
        assert_true("nav-group-layout-compact" in styles_css, "首页导航分组应支持布局自定义")
        assert_true("nav-group-radius-pill" in styles_css, "首页导航分组应支持卡片形状自定义")
        assert_true("overflow-x: hidden" in styles_css, "手机端页面应禁止横向溢出")
        assert_true("grid-template-columns: 1fr !important" in styles_css, "手机端主要功能区应强制单列显示")
        assert_true("padding: 10px 10px 90px 66px" in styles_css, "手机端内容区应给左侧菜单留出空间")
        assert_true("responsive-baseline" in styles_css, "所有页面应有统一响应式基线")
        assert_true("@media (max-width: 1024px)" in styles_css, "所有页面应覆盖平板/窄屏断点")
        assert_true("@media (max-width: 420px)" in styles_css, "所有页面应覆盖小屏手机断点")
        assert_true("max-width: 100vw" in styles_css, "全局布局应避免横向溢出")
        assert_true("width: min(920px, calc(100vw - 24px))" in styles_css, "弹窗应按视口宽度自动收缩")
        assert_true(".responsive-baseline .container-titlebar" in styles_css, "容器页面应纳入响应式基线")
        assert_true(".responsive-baseline .compose-monitor-layout" in styles_css, "Compose 页面应纳入响应式基线")
        assert_true(".responsive-baseline .volume-table-head" in styles_css, "Docker 卷页面应纳入响应式基线")
        assert_true(".responsive-baseline .settings-content" in styles_css, "系统设置页应纳入响应式基线")
        assert_true(".sidebar:hover .nav" in styles_css, "桌面端侧边栏应支持鼠标移入自动展开")
        assert_true("width: 184px" in styles_css, "桌面端侧边栏展开后应显示文字菜单")
        assert_true("nav-minimal-group" in styles_css, "首页导航应使用隔离的极简分组面板")
        assert_true("nav-minimal-hero" in styles_css, "首页导航应使用极简标题和搜索结构")
        assert_true("nav-workbench-search" in styles_css, "首页导航搜索框应使用独立工作台搜索样式")
        assert_true("nav-workbench-group" in styles_css, "首页导航分组应使用清晰的工作台分组层级")
        assert_true("nav-workbench-centered" in styles_css, "首页导航顶部内容应使用居中布局规则")
        assert_true("nav-compact-modal" in styles_css, "首页导航交互弹窗应使用紧凑尺寸覆盖")
        assert_true("width: min(680px, calc(100vw - 40px))" in styles_css, "首页导航交互弹窗宽度应收敛")
        assert_true("linear-gradient(135deg, #1a2d73" not in styles_css, "首页导航不应继续使用深蓝渐变画布")
        assert_true("compose-repair-note" in styles_css, "Compose 修正结果应有提示样式")
        assert_true("compose-ai-requirement textarea" in styles_css, "Compose AI 自定义要求应提供可编辑样式")
        assert_true("yaml-repaired" in styles_css, "Compose 修正内容应高亮显示")
        assert_true("compose-ai-preview-shell" in styles_css, "Compose AI 修正应使用右侧预览窗口")
        assert_true("compose-dark-editor" in styles_css, "Compose 代码编辑区应保持深色")
        assert_true("compose-codemirror-host" in styles_css, "Compose 编辑器应使用 CodeMirror 容器")
        assert_true("lineNumbers: true" in page, "CodeMirror 应启用原生行号栏")
        assert_true("line-height: 1.38" in styles_css, "Compose 编辑器行距应更紧凑")
        assert_true(".CodeMirror-gutters" in styles_css, "Compose 编辑器应显示 CodeMirror 原生行号 gutter")
        assert_true(".cm-string" in styles_css, "Compose 编辑器应提供 YAML 语法高亮配色")
        assert_true("compose-editor-fallback" in styles_css, "CodeMirror 加载失败时应保留可编辑 fallback")
        assert_true("composeButtonPulse" in styles_css, "Compose 操作按钮应提供点击反馈动画")
        assert_true("compose-panel" in styles_css, "Compose 管理功能卡片应使用彩色区分")
        assert_true("compose-monitor-layout" in app_js, "Compose 管理应采用 D3 监控控制台结构")
        assert_true('["compose", "Compose"' in app_js, "Compose 菜单应显示为 Compose")
        assert_true("resetComposeEditor" in app_js, "每次打开 Compose 菜单应进入空白编辑窗口")
        assert_true("创建空白编辑窗口" not in app_js, "Compose 页面不应再显示创建空白编辑窗口文案")
        assert_true("<b>+</b> 新建项目" in app_js, "Compose 新建项目入口应位于项目名输入框旁")
        assert_true("compose-run-overview" in styles_css, "Compose 管理应提供运行概览样式")
        assert_true("compose-terminal-tabs" in styles_css, "Compose 管理应提供日志终端样式")
        assert_true("compose-inline-create" in styles_css, "Compose 新建项目应有顶部输入区域样式")
        assert_true("compose-project-card:nth-child(3n + 2)" not in styles_css, "Compose 项目卡片不应再使用杂色分层")
        assert_true(".compose-reference-layout .compose-project-card::after" in styles_css, "Compose 项目列表不应显示重复状态圆点")
        assert_true("compose-backup-modal" in styles_css, "Compose 备份恢复应使用选择弹窗")
        assert_true("compose-backup-restore-new" in app_js, "Compose 备份应支持恢复为新项目")
        assert_true("当前用户：" not in app_js, "所有页面都不应显示顶部当前用户栏")
        _, update_job = client.request("POST", "/api/docker/containers/fake-container/update-job", expect=202)
        job_id = update_job["job"]["id"]
        _, job_state = client.request("GET", f"/api/docker/jobs/{job_id}")
        assert_true(job_state["job"]["container_id"] == "fake-container", "更新任务应记录容器 ID")

        _, overview = client.request("GET", "/api/overview")
        assert_true("docker" in overview, "总览应包含 Docker 状态")
        _, nav_prefs = client.request("GET", "/api/dashboard/nav")
        assert_true("prefs" in nav_prefs and "card_style" in nav_prefs["prefs"], "首页导航外观偏好应可读取")
        _, nav_saved = client.request("PUT", "/api/dashboard/nav", {"title": "我的导航", "section_title": "常用应用", "density": "compact", "web_search_engine": "bing", "groups": {"Docker": {"collapsed": True, "color": "#16a34a", "layout": "compact", "card_size": "large", "icon_size": "small", "gap": "loose", "radius": "pill"}}})
        assert_true(nav_saved["prefs"]["title"] == "我的导航", "首页导航标题应可保存")
        assert_true(nav_saved["prefs"]["section_title"] == "常用应用", "导航页应用区标题应可保存")
        assert_true(nav_saved["prefs"]["web_search_engine"] == "bing", "导航页搜索引擎应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["collapsed"] is True, "首页导航分组折叠状态应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["layout"] == "compact", "首页导航分组布局偏好应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["card_size"] == "large", "首页导航分组卡片尺寸偏好应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["icon_size"] == "small", "首页导航分组图标尺寸偏好应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["gap"] == "loose", "首页导航分组间距偏好应可保存")
        assert_true(nav_saved["prefs"]["groups"]["Docker"]["radius"] == "pill", "首页导航分组卡片形状偏好应可保存")

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
                "shape": "pill",
                "icon_shape": "squircle",
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
        assert_true(created_card["card"]["shape"] == "pill", "导航卡片应保存卡片形状")
        assert_true(created_card["card"]["icon_shape"] == "squircle", "导航卡片应保存图标形状")
        assert_true(created_card["card"]["icon_data"].startswith("data:image/gif;base64,"), "导航卡片应保存上传图标")
        client.request("PUT", f"/api/cards/{card_id}", {"title": "测试服务2", "sort_order": 5, "size": "small", "shape": "rounded", "icon_shape": "circle", "clear_icon": True})
        _, cards = client.request("GET", "/api/cards")
        assert_true(cards["cards"][0]["title"] == "测试服务2", "导航卡片应可编辑")
        assert_true(cards["cards"][0]["size"] == "small", "导航卡片尺寸应可编辑")
        assert_true(cards["cards"][0]["shape"] == "rounded", "导航卡片形状应可编辑")
        assert_true(cards["cards"][0]["icon_shape"] == "circle", "导航图标形状应可编辑")
        assert_true(cards["cards"][0]["icon_data"] == "", "导航卡片图标应可清除")

        _, project = client.request("POST", "/api/compose/projects", {"name": "demo"}, expect=201)
        compose_path = urllib.parse.quote(project["project"]["path"], safe="")
        _, compose_file = client.request("GET", f"/api/compose/file?path={compose_path}")
        assert_true("services:" in compose_file["content"], "Compose 文件应可读取")
        _, compose_backup = client.request("POST", "/api/compose/backups", {"path": project["project"]["path"], "content": compose_file["content"]}, expect=201)
        backup_name = compose_backup["backup"]["name"]
        _, compose_backups = client.request("GET", "/api/compose/backups")
        assert_true(any(item["name"] == backup_name for item in compose_backups["backups"]), "Compose 备份列表应显示备份")
        _, compose_backup_read = client.request("GET", f"/api/compose/backups/{urllib.parse.quote(backup_name, safe='')}")
        assert_true("services:" in compose_backup_read["backup"]["content"], "Compose 备份应可预览内容")
        client.request(
            "PUT",
            "/api/compose/file",
            {"path": project["project"]["path"], "content": compose_file["content"] + "\n# smoke\n"},
        )
        _, restored = client.request(
            "POST",
            f"/api/compose/backups/{urllib.parse.quote(backup_name, safe='')}/restore",
            {"path": project["project"]["path"]},
        )
        assert_true(restored["project"]["path"] == project["project"]["path"], "Compose 备份应可恢复到当前项目")
        _, restored_new = client.request(
            "POST",
            f"/api/compose/backups/{urllib.parse.quote(backup_name, safe='')}/restore-new",
            {"name": "demo-restored"},
            expect=201,
        )
        assert_true(restored_new["project"]["name"] == "demo-restored", "Compose 备份应可恢复为新项目")
        client.request("DELETE", f"/api/compose/backups/{urllib.parse.quote(backup_name, safe='')}")
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
        volume_code, volume_status = client.request("GET", "/api/docker/volumes", expect=(200, 502))
        if volume_code == 502:
            assert_true("Docker socket not found" in volume_status["error"], "无 Docker 环境时卷管理应返回明确错误")
        else:
            assert_true("volumes" in volume_status and "backups" in volume_status, "有 Docker 环境时应返回卷和备份列表")
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
        repair_code, repair_error = client.request(
            "POST",
            "/api/compose/repair",
            {"content": "app：\n\timage: nginx\n"},
            expect=400,
        )
        assert_true(repair_code == 400 and "AI" in repair_error["error"], "未配置 AI 时 Compose 修正应返回明确提示")

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

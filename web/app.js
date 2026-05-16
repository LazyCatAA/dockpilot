const state = {
  session: null,
  tab: "dashboard",
  error: "",
  loading: false,
  overview: null,
  dashboardWidgets: [],
  cards: [],
  editingCard: null,
  cardModal: { open: false, iconMime: "", iconBase64: "", clearIcon: false },
  cardContextMenu: { open: false, x: 0, y: 0, id: null },
  containers: [],
  containerBackups: [],
  images: { items: [], query: "", remoteQuery: "", searchResults: [], pullOutput: "", proxy: "", registryMirrors: [], networkProxy: "", proxyTest: "", proxyOk: null, pullMode: "proxy" },
  imagePullJob: null,
  containerView: "card",
  containerFilter: "all",
  containerDetail: null,
  containerUpdateJobs: {},
  containerUpdateCheck: { active: false, done: 0, total: 0, failed: 0 },
  sidebarCollapsed: false,
  logs: { id: "", text: "" },
  compose: { projects: [], selected: "", content: "", output: "", repair: null, repairLines: [] },
  files: { roots: [], root: "", path: "", items: [], editPath: "", content: "" },
  settings: null,
};

const containerUpdatePollTimers = {};
const containerUpdateClearTimers = {};
const containerAutoChecked = new Set();
let imagePullPollTimer = null;

const tabs = [
  ["dashboard", "总览"],
  ["containers", "容器"],
  ["images", "镜像"],
  ["compose", "Compose"],
  ["files", "文件"],
  ["settings", "设置"],
];

const navGroups = [
  { title: "发现", items: [["dashboard", "首页导航", "⌂"]] },
  { title: "Docker", items: [["containers", "容器管理", "▦"], ["images", "镜像库", "◉"], ["compose", "Compose管理", "◇"]] },
  { title: "系统", items: [["files", "文件管理", "≡"], ["settings", "系统设置", "⚙"]] },
];

const app = document.getElementById("app");

function h(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function highlightYaml(value) {
  return String(value || "")
    .split("\n")
    .map((line, index) => {
      if (/^\s*#/.test(line)) return `<span class="yaml-comment">${h(line)}</span>`;
      let escaped = h(line);
      escaped = escaped.replace(
        /^(\s*)([A-Za-z0-9_.-]+)(:)/,
        `$1<span class="yaml-key">$2</span><span class="yaml-punc">$3</span>`
      );
      escaped = escaped.replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, `<span class="yaml-string">$1</span>`);
      escaped = escaped.replace(/\b(true|false|null|yes|no|on|off)\b/gi, `<span class="yaml-bool">$1</span>`);
      escaped = escaped.replace(/(^|\s)(-\s)/g, `$1<span class="yaml-list">$2</span>`);
      escaped = escaped.replace(/(#.*)$/g, `<span class="yaml-comment">$1</span>`);
      return state.compose.repairLines.includes(index + 1) ? `<span class="yaml-repaired">${escaped}</span>` : escaped;
    })
    .join("\n");
}

function syncComposeHighlight() {
  const editor = document.getElementById("composeEditor");
  const highlight = document.getElementById("composeHighlight");
  if (!editor || !highlight) return;
  highlight.innerHTML = `${highlightYaml(editor.value)}\n`;
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function fmtBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function shortId(id) {
  return String(id || "").slice(0, 12);
}

function namesOf(container) {
  return (container.Names || []).map((name) => name.replace(/^\//, "")).join(", ");
}

function formatPorts(ports) {
  if (!ports || !ports.length) return "-";
  return ports
    .map((port) => {
      if (port.PublicPort) return `${port.PublicPort}:${port.PrivatePort}/${port.Type}`;
      return `${port.PrivatePort}/${port.Type}`;
    })
    .join(", ");
}

function pageTitle() {
  return tabs.find(([key]) => key === state.tab)?.[1] || "总览";
}

function containerName(container) {
  return namesOf(container) || shortId(container.Id);
}

function containerKey(container) {
  return container.DockPilot?.key || containerName(container);
}

function containerColor(container) {
  return container.DockPilot?.color || "#2f80ed";
}

function zhContainerState(value) {
  const stateText = String(value || "").toLowerCase();
  const map = {
    running: "运行中",
    exited: "已停止",
    created: "已创建",
    paused: "已暂停",
    restarting: "重启中",
    dead: "异常",
  };
  return map[stateText] || value || "未知";
}

function defaultContainerIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.8 20 7.2v9.6l-8 4.4-8-4.4V7.2L12 2.8Z" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="m4.6 7.6 7.4 4 7.4-4M12 11.6v8.2" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="m8.4 5.5 7.4 4.2" fill="none" stroke="currentColor" stroke-width="1.8" />
    </svg>
  `;
}

function containerIcon(container) {
  const icon = container.DockPilot?.icon_data;
  if (icon) return `<img src="${h(icon)}" alt="" />`;
  return defaultContainerIcon();
}

function containerStats() {
  const total = state.containers.length;
  const running = state.containers.filter((item) => String(item.State).toLowerCase() === "running").length;
  const updates = state.containers.filter((item) => item.DockPilot?.update_available).length;
  return { total, running, stopped: Math.max(total - running, 0), updates };
}

function isContainerUpdating(containerId) {
  const job = state.containerUpdateJobs[containerId];
  return Boolean(job && ["queued", "running"].includes(job.status));
}

function containerUpdateJob(containerId) {
  return state.containerUpdateJobs[containerId] || null;
}

function updateJobStatusText(status) {
  const map = {
    queued: "等待中",
    running: "更新中",
    success: "已完成",
    error: "失败",
  };
  return map[status] || "更新任务";
}

function renderContainerCardUpdateProgress(containerId) {
  const job = containerUpdateJob(containerId);
  if (!job) return "";
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const status = String(job.status || "queued");
  return `
    <div class="container-card-update-progress ${h(status)}">
      <div class="container-card-update-progress-head">
        <div>
          <strong>${h(updateJobStatusText(status))}</strong>
          <span>${h(job.step || "容器更新")}</span>
        </div>
        <b>${progress}%</b>
      </div>
      <div class="container-card-update-track"><i style="width:${progress}%"></i></div>
      <p>${h(job.message || "正在处理容器更新任务。")}</p>
    </div>
  `;
}

function shouldAutoCheckContainerUpdate(container) {
  const key = containerKey(container);
  if (!key || containerAutoChecked.has(key)) return false;
  const checkedAt = Number(container.DockPilot?.update_checked_at || 0);
  if (!checkedAt) return true;
  return Date.now() / 1000 - checkedAt > 12 * 60 * 60;
}

function updateContainerCheckState(containerId, data) {
  const item = state.containers.find((container) => container.Id === containerId);
  if (!item) return;
  item.DockPilot = item.DockPilot || {};
  if (data.ok && typeof data.update_available === "boolean") {
    item.DockPilot.update_available = data.update_available;
    item.DockPilot.update_checked_at = Math.floor(Date.now() / 1000);
    item.DockPilot.update_check_error = "";
  } else if (!data.ok) {
    item.DockPilot.update_check_error = data.message || "检查更新失败。";
  }
}

function filteredContainers() {
  if (state.containerFilter === "running") {
    return state.containers.filter((item) => String(item.State).toLowerCase() === "running");
  }
  if (state.containerFilter === "stopped") {
    return state.containers.filter((item) => String(item.State).toLowerCase() !== "running");
  }
  if (state.containerFilter === "updates") {
    return state.containers.filter((item) => item.DockPilot?.update_available);
  }
  return state.containers;
}

function containerFilterTitle() {
  const map = { all: "全部容器", running: "运行中容器", stopped: "已停止容器", updates: "有更新容器" };
  return map[state.containerFilter] || "全部容器";
}

function zhServiceState(value) {
  const stateText = String(value || "").toLowerCase();
  if (stateText === "missing") return "未部署";
  return zhContainerState(stateText);
}

function projectStateTone(project) {
  const items = project.containers || [];
  if (!items.length || items.every((item) => item.state === "missing")) return "missing";
  if (items.some((item) => String(item.state).toLowerCase() === "running")) return "running";
  return "stopped";
}

function zhDurationText(text) {
  const normalized = String(text || "").toLowerCase();
  const match = normalized.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?/);
  if (!match) return text || "-";
  const value = Number(match[1]);
  const units = {
    second: "秒",
    minute: "分钟",
    hour: "小时",
    day: "天",
    week: "周",
    month: "个月",
    year: "年",
  };
  return `${value}${units[match[2]] || ""}`;
}

function containerRuntime(container) {
  const status = String(container.Status || "");
  const stateValue = String(container.State || "").toLowerCase();
  if (stateValue === "running") {
    const match = status.match(/^Up\s+(.+?)(?:\s+\(|$)/i);
    return `运行: ${zhDurationText(match ? match[1] : "")}`;
  }
  if (stateValue === "exited") return "已停止";
  return zhContainerState(container.State);
}

function containerImageName(container) {
  return container.DockPilot?.image_name || container.Image || container.ImageID || "-";
}

function imageTags(image) {
  const tags = image.RepoTags || [];
  return tags.filter((tag) => tag && tag !== "<none>:<none>");
}

function imageTitle(image) {
  const tags = imageTags(image);
  if (tags.length) return tags[0];
  return shortId(image.Id || image.ID || "");
}

function imageSubtitle(image) {
  const tags = imageTags(image);
  if (tags.length > 1) return tags.slice(1, 3).join(" / ");
  const digests = image.RepoDigests || [];
  return digests[0] || "未命名镜像";
}

function imageCreatedText(image) {
  const created = Number(image.Created || 0);
  if (!created) return "-";
  return new Date(created * 1000).toLocaleDateString("zh-CN");
}

function jobProgressText(job) {
  if (!job) return "";
  const statusMap = { queued: "等待中", running: "进行中", success: "已完成", error: "失败" };
  return statusMap[job.status] || "任务";
}

function proxyStatusText() {
  if (!state.images.networkProxy) return "未设置";
  if (state.images.proxyOk === true) return "连通";
  if (state.images.proxyOk === false) return "不连通";
  return "检测中";
}

function dashboardWidgetValue(widget, overview) {
  if (widget.type === "host") {
    const host = overview.host || {};
    return {
      value: host.memory_total ? `${Math.round((host.memory_used / host.memory_total) * 100)}%` : `${(host.load || [0])[0] || 0}`,
      detail: host.memory_total ? `内存 ${fmtBytes(host.memory_used)} / ${fmtBytes(host.memory_total)}` : "主机负载",
      tone: "blue",
    };
  }
  if (widget.type === "docker") {
    const docker = overview.docker || {};
    return {
      value: docker.available ? "在线" : "离线",
      detail: docker.available ? "Docker 引擎可用" : zhError(docker.message || "连接失败"),
      tone: docker.available ? "green" : "red",
    };
  }
  const containers = overview.containers || {};
  return {
    value: `${containers.running || 0}/${containers.total || 0}`,
    detail: "运行中 / 总容器",
    tone: "orange",
  };
}

async function saveDashboardWidgets(widgets) {
  const data = await api("/api/dashboard/widgets", { method: "PUT", body: { widgets } });
  state.dashboardWidgets = data.widgets || [];
}

function filteredImages() {
  const query = state.images.query.trim().toLowerCase();
  if (!query) return state.images.items;
  return state.images.items.filter((image) => {
    const haystack = [image.Id, ...(image.RepoTags || []), ...(image.RepoDigests || [])].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function cardGroups() {
  const groups = state.cards.reduce((acc, card) => {
    const key = card.group_name || "应用";
    acc[key] = acc[key] || [];
    acc[key].push(card);
    return acc;
  }, {});
  const entries = Object.entries(groups);
  return entries.length ? entries : [["Docker", []]];
}

function cardById(id) {
  return state.cards.find((item) => item.id === Number(id)) || null;
}

function cardDefaultUrl(card) {
  return card.internal_url || card.url || "";
}

function cardSize(card) {
  return ["small", "medium", "large"].includes(card.size) ? card.size : "medium";
}

function cardStyle(card) {
  return ["default", "soft", "outline"].includes(card.style) ? card.style : "default";
}

function cardIconMarkup(card) {
  if (card.icon_data) return `<img src="${h(card.icon_data)}" alt="" />`;
  const label = (card.icon || card.title.slice(0, 2).toUpperCase()).slice(0, 4);
  return `<span>${h(label)}</span>`;
}

function openCardModal(card = null, groupName = "Docker") {
  state.editingCard = card
    ? { ...card }
    : {
        title: "",
        url: "",
        internal_url: "",
        description: "",
        group_name: groupName || "Docker",
        icon: "",
        color: "#2f80ed",
        title_color: "#111827",
        card_color: "#ffffff",
        size: "medium",
        style: "default",
        icon_data: "",
      };
  state.cardModal = { open: true, iconMime: "", iconBase64: "", clearIcon: false };
  state.cardContextMenu = { open: false, x: 0, y: 0, id: null };
}

function closeCardModal() {
  state.editingCard = null;
  state.cardModal = { open: false, iconMime: "", iconBase64: "", clearIcon: false };
}

function closeCardContextMenu() {
  state.cardContextMenu = { open: false, x: 0, y: 0, id: null };
}

function renderNav() {
  return navGroups
    .map(
      (group) => `
      <div class="nav-group">
        <div class="nav-title">${h(group.title)}</div>
        ${group.items
          .map(
            ([key, label, icon]) =>
              `<button class="${state.tab === key ? "active" : ""}" data-action="nav" data-tab="${key}">
                <span class="nav-icon">${h(icon)}</span><span>${h(label)}</span>
              </button>`
          )
          .join("")}
      </div>
    `
    )
    .join("");
}

function renderMetric(label, value, hint, tone = "") {
  return `
    <div class="metric ${tone}">
      <span>${h(label)}</span>
      <strong>${h(value)}</strong>
      <small>${h(hint || "")}</small>
    </div>
  `;
}

function joinPath(base, name) {
  return [base, name].filter(Boolean).join("/");
}

function parentPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function zhError(message) {
  const text = String(message || "");
  const rules = [
    ["authentication required", "需要先登录。"],
    ["invalid username or password", "用户名或密码不正确。"],
    ["password must be at least 8 characters", "密码至少需要 8 个字符。"],
    ["setup already completed", "初始化已经完成，请直接登录。"],
    ["Docker socket not found", "找不到 Docker socket"],
    ["Docker API", "Docker 接口错误"],
    ["title and url are required", "标题和地址不能为空。"],
    ["invalid url", "访问地址格式不正确，只支持 http、https 或站内相对路径。"],
    ["card not found", "没有找到这个导航卡片。"],
    ["no fields to update", "没有可更新的内容。"],
    ["no compose roots configured", "还没有配置 Compose 目录。"],
    ["project already exists", "项目已经存在。"],
    ["not a compose file", "这不是 Compose 文件。"],
    ["compose file is outside configured roots", "Compose 文件不在允许的目录内。"],
    ["compose file not found", "没有找到 Compose 文件。"],
    ["unsupported compose action", "不支持这个 Compose 操作。"],
    ["docker CLI not found in PATH", "当前环境找不到 docker 命令。"],
    ["Command timed out.", "命令执行超时。"],
    ["unknown file root", "未知的文件根目录。"],
    ["path is outside configured root", "路径超出了允许的文件目录。"],
    ["path not found", "路径不存在。"],
    ["path is not a directory", "这个路径不是目录。"],
    ["file not found", "文件不存在。"],
    ["file is larger than text preview limit", "文件太大，不能直接预览。"],
    ["upload target must be a directory", "上传目标必须是目录。"],
    ["file name is required", "文件名不能为空。"],
    ["new name is required", "新名称不能为空。"],
    ["destination path is required", "目标路径不能为空。"],
    ["destination already exists", "目标路径已经存在。"],
    ["cannot move or copy a directory into itself", "不能把目录移动或复制到自身内部。"],
    ["refusing to operate on a root directory", "不能对根目录执行这个操作。"],
    ["container key is required", "容器标识不能为空。"],
    ["backup not found", "没有找到这个备份。"],
    ["image name is not checkable", "这个镜像名称不能检查更新。"],
    ["unsupported icon image type", "只支持 PNG、JPG、WebP 或 GIF 图标。"],
    ["invalid icon image data", "图标文件读取失败。"],
    ["icon image is empty", "图标文件为空。"],
    ["icon image is too large", "图标不能超过 6MB。"],
    ["update check timed out", "检查更新超时。"],
    ["container update timed out", "容器更新超时。"],
    ["docker pull failed", "镜像拉取失败。"],
    ["docker compose pull failed", "Compose 拉取镜像失败。"],
    ["docker compose up failed", "Compose 重建容器失败。"],
    ["failed to parse docker output", "解析 Docker 输出失败。"],
    ["command is required", "请输入部署命令。"],
    ["command must start with docker run", "命令必须以 docker run 开头。"],
    ["docker image is required", "命令中没有识别到镜像名称。"],
    ["docker pull timed out", "镜像拉取超时。"],
    ["docker tag failed", "镜像代理拉取成功，但打回原始镜像名失败。"],
    ["image search query is required", "请输入要搜索的镜像关键词。"],
    ["user not found", "用户不存在。"],
    ["refusing to delete a root directory", "不能删除根目录。"],
    ["request body too large", "请求内容太大。"],
    ["not found", "没有找到请求的资源。"],
    ["method not allowed", "不支持这个请求方式。"],
  ];
  const match = rules.find(([key]) => text.includes(key));
  return match ? text.replace(match[0], match[1]) : text;
}

async function api(path, options = {}) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (config.body && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  const type = response.headers.get("Content-Type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (response.status === 401 && path !== "/api/session") {
    state.session = { setup_required: false, authenticated: false, user: null };
    state.error = "登录已过期，请重新登录。";
    render();
    throw new Error("需要先登录。");
  }
  if (!response.ok) {
    throw new Error(zhError(payload.error || payload || `请求失败：${response.status}`));
  }
  return payload;
}

async function boot() {
  try {
    state.session = await api("/api/session");
    render();
    if (state.session.authenticated) await refreshCurrent();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function refreshCurrent() {
  state.loading = true;
  state.error = "";
  render();
  try {
    if (state.tab === "dashboard") await loadDashboard();
    if (state.tab === "containers") await loadContainers();
    if (state.tab === "images") await loadImages();
    if (state.tab === "compose") await loadCompose();
    if (state.tab === "files") await loadFiles();
    if (state.tab === "settings") await loadSettings();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function loadDashboard() {
  const [overview, cards] = await Promise.all([api("/api/overview"), api("/api/cards")]);
  state.overview = overview;
  state.dashboardWidgets = overview.dashboard_widgets || [];
  state.cards = cards.cards || [];
}

async function loadContainers() {
  const [data, backups] = await Promise.all([api("/api/docker/containers"), api("/api/docker/backups")]);
  state.containers = data.containers || [];
  state.containerBackups = backups.backups || [];
  scheduleContainerUpdateChecks();
}

async function loadImages() {
  const data = await api("/api/docker/images");
  state.images.items = data.images || [];
  state.images.proxy = data.image_registry_proxy || state.images.proxy || "";
  state.images.registryMirrors = data.registry_mirrors || (state.images.proxy ? [state.images.proxy] : []);
  state.images.networkProxy = data.network_proxy || state.images.networkProxy || "";
  if (state.images.networkProxy) scheduleImageProxyTest();
}

function scheduleImageProxyTest() {
  const proxy = state.images.networkProxy;
  if (!proxy) {
    state.images.proxyOk = null;
    state.images.proxyTest = "";
    return;
  }
  setTimeout(() => testImageProxy(proxy), 150);
}

async function testImageProxy(proxy = state.images.networkProxy) {
  if (!proxy) return;
  state.images.proxyOk = null;
  state.images.proxyTest = "";
  render();
  try {
    const result = await api("/api/docker/proxy/test", { method: "POST", body: { network_proxy: proxy } });
    state.images.proxyOk = Boolean(result.ok);
  } catch (error) {
    state.images.proxyOk = false;
  }
  render();
}

async function startContainerUpdate(containerId) {
  if (containerUpdateClearTimers[containerId]) clearTimeout(containerUpdateClearTimers[containerId]);
  const data = await api(`/api/docker/containers/${encodeURIComponent(containerId)}/update-job`, { method: "POST" });
  state.containerUpdateJobs = { ...state.containerUpdateJobs, [containerId]: data.job };
  state.error = "容器更新任务已开始。";
  render();
  pollContainerUpdateJob(containerId, data.job.id);
}

async function pollContainerUpdateJob(containerId, jobId) {
  if (containerUpdatePollTimers[containerId]) clearTimeout(containerUpdatePollTimers[containerId]);
  try {
    const data = await api(`/api/docker/jobs/${encodeURIComponent(jobId)}`);
    state.containerUpdateJobs = { ...state.containerUpdateJobs, [containerId]: data.job };
    const status = String(data.job.status || "");
    render();
    if (["queued", "running"].includes(status)) {
      containerUpdatePollTimers[containerId] = setTimeout(() => pollContainerUpdateJob(containerId, jobId), 1000);
      return;
    }
    await reloadContainersQuietly();
    state.containerUpdateJobs = { ...state.containerUpdateJobs, [containerId]: data.job };
    state.error =
      status === "success"
        ? data.job.message || "容器更新完成。"
        : zhError(data.job.error || data.job.message || "容器更新失败。");
    render();
    containerUpdateClearTimers[containerId] = setTimeout(() => {
      if (state.containerUpdateJobs[containerId]?.id === jobId) {
        const nextJobs = { ...state.containerUpdateJobs };
        delete nextJobs[containerId];
        state.containerUpdateJobs = nextJobs;
        render();
      }
    }, status === "success" ? 5000 : 12000);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function reloadContainersQuietly() {
  const [data, backups] = await Promise.all([api("/api/docker/containers"), api("/api/docker/backups")]);
  state.containers = data.containers || [];
  state.containerBackups = backups.backups || [];
}

async function startImagePull(image, useProxy) {
  if (imagePullPollTimer) clearTimeout(imagePullPollTimer);
  const data = await api("/api/docker/images/pull-job", { method: "POST", body: { image, use_proxy: useProxy } });
  state.imagePullJob = data.job;
  state.images.pullOutput = "";
  render();
  pollImagePullJob(data.job.id);
}

async function pollImagePullJob(jobId) {
  if (imagePullPollTimer) clearTimeout(imagePullPollTimer);
  try {
    const data = await api(`/api/docker/jobs/${encodeURIComponent(jobId)}`);
    state.imagePullJob = data.job;
    const status = String(data.job.status || "");
    render();
    if (["queued", "running"].includes(status)) {
      imagePullPollTimer = setTimeout(() => pollImagePullJob(jobId), 1000);
      return;
    }
    state.images.pullOutput = data.job.error || data.job.message || "";
    if (status === "success") await loadImages();
    state.error = status === "success" ? data.job.message || "镜像拉取完成。" : zhError(data.job.error || data.job.message || "镜像拉取失败。");
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function checkContainerUpdates(containers, { force = false } = {}) {
  const targets = force ? containers : containers.filter(shouldAutoCheckContainerUpdate);
  if (!targets.length || state.containerUpdateCheck.active) return;
  state.containerUpdateCheck = { active: true, done: 0, total: targets.length, failed: 0 };
  render();
  for (const item of targets) {
    const key = containerKey(item);
    if (key) containerAutoChecked.add(key);
    try {
      const data = await api(`/api/docker/containers/${encodeURIComponent(item.Id)}/check-update`, { method: "POST" });
      updateContainerCheckState(item.Id, data);
    } catch (error) {
      item.DockPilot = item.DockPilot || {};
      item.DockPilot.update_check_error = error.message;
      state.containerUpdateCheck.failed += 1;
    } finally {
      state.containerUpdateCheck.done += 1;
      render();
    }
  }
  state.containerUpdateCheck.active = false;
  state.error = state.containerUpdateCheck.failed
    ? `更新检测完成，${state.containerUpdateCheck.failed} 个容器检测失败。`
    : "更新检测完成。";
  render();
}

function scheduleContainerUpdateChecks() {
  if (state.tab !== "containers") return;
  const targets = state.containers.filter(shouldAutoCheckContainerUpdate);
  if (!targets.length) return;
  setTimeout(() => checkContainerUpdates(state.containers), 300);
}

async function loadCompose() {
  const data = await api("/api/compose/projects");
  state.compose.projects = data.projects || [];
  if (!state.compose.selected && state.compose.projects[0]) {
    await selectCompose(state.compose.projects[0].path);
  } else if (state.compose.selected && !state.compose.projects.some((project) => project.path === state.compose.selected)) {
    state.compose.selected = "";
    state.compose.content = "";
  }
}

async function selectCompose(path) {
  state.compose.selected = path;
  const data = await api(`/api/compose/file?path=${encodeURIComponent(path)}`);
  state.compose.content = data.content || "";
}

async function loadFiles() {
  if (!state.files.roots.length) {
    const roots = await api("/api/files/roots");
    state.files.roots = roots.roots || [];
    state.files.root = state.files.root || (state.files.roots[0] && state.files.roots[0].name) || "";
  }
  if (state.files.root) {
    const data = await api(
      `/api/files/list?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(state.files.path)}`
    );
    state.files.items = data.items || [];
  }
}

async function loadSettings() {
  state.settings = await api("/api/settings");
}

function render() {
  if (!state.session) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card">正在加载...</div></div>`;
    return;
  }
  if (!state.session.authenticated) {
    renderAuth();
    return;
  }
  app.innerHTML = `
    <div class="layout ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">DP</div>
          <div class="brand-text"><h1>DockPilot</h1><p>私有 NAS 控制台</p></div>
          <button class="sidebar-toggle" title="隐藏/显示侧边栏" data-action="sidebar-toggle">${state.sidebarCollapsed ? "›" : "‹"}</button>
        </div>
        <nav class="nav">${renderNav()}</nav>
      </aside>
      <main class="content">
        ${
          state.tab === "containers"
            ? ""
            : `<div class="topbar">
                <div>
                  <h2>${h(pageTitle())}</h2>
                  <div class="muted">当前用户：${h(state.session.user?.username || "admin")}</div>
                </div>
                <div class="top-actions">
                  <button class="circle" title="刷新" data-action="refresh">⟳</button>
                  <button class="circle" title="退出登录" data-action="logout">⎋</button>
                </div>
              </div>`
        }
        ${state.error ? `<div class="notice">${h(state.error)}</div>` : ""}
        ${state.loading ? `<div class="empty">正在加载当前页面...</div>` : renderCurrent()}
      </main>
    </div>
  `;
}

function renderAuth() {
  const setup = state.session.setup_required;
  app.innerHTML = `
    <div class="auth-wrap">
      <form class="auth-card form-stack" id="authForm">
        <div class="brand">
          <div class="mark">DP</div>
          <div>
            <h1>DockPilot</h1>
            <p>${setup ? "创建第一个管理员账号。" : "登录后管理这台主机。"}</p>
          </div>
        </div>
        ${state.error ? `<div class="notice">${h(state.error)}</div>` : ""}
        <div class="field">
          <label>用户名</label>
          <input name="username" autocomplete="username" value="${setup ? "admin" : ""}" required />
        </div>
        <div class="field">
          <label>密码</label>
          <input name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" minlength="8" required />
        </div>
        <button class="primary" type="submit">${setup ? "创建管理员" : "登录"}</button>
      </form>
    </div>
  `;
}

function renderCurrent() {
  if (state.tab === "dashboard") return renderDashboard();
  if (state.tab === "containers") return renderContainers();
  if (state.tab === "images") return renderImages();
  if (state.tab === "compose") return renderCompose();
  if (state.tab === "files") return renderFiles();
  if (state.tab === "settings") return renderSettings();
  return "";
}

function renderDashboard() {
  return `
    <section class="nav-home">
      <div class="nav-hero">
        <div>
          <span>DockPilot 导航中心</span>
          <h2>服务入口和主机状态集中管理</h2>
        </div>
        <button class="nav-hero-add" data-action="card-add" data-group="Docker">添加入口</button>
      </div>
      ${renderDashboardWidgets()}
      ${renderCards()}
      ${renderCardContextMenu()}
      ${renderCardModal()}
    </section>
  `;
}

function renderDashboardWidgets() {
  const overview = state.overview || {};
  const visible = state.dashboardWidgets.filter((widget) => widget.visible);
  const hidden = state.dashboardWidgets.filter((widget) => !widget.visible);
  return `
    <section class="dashboard-widget-panel nav-section">
      <div class="panel-head">
        <div>
          <h3>状态小卡片</h3>
          <span class="muted">可自定义显示主机状态、Docker 状态或容器监控。</span>
        </div>
        <form id="dashboardWidgetForm" class="widget-form">
          <input name="title" placeholder="小卡片标题" />
          <select name="type">
            <option value="host">物理机运行状态</option>
            <option value="docker">Docker 状态</option>
            <option value="containers">容器监控</option>
          </select>
          <button type="submit">添加</button>
        </form>
      </div>
      ${
        visible.length
          ? `<div class="dashboard-widget-grid">${visible
              .map((widget) => {
                const info = dashboardWidgetValue(widget, overview);
                return `
                  <article class="dashboard-widget ${h(info.tone)}">
                    <div>
                      <span>${h(widget.title)}</span>
                      <strong>${h(info.value)}</strong>
                      <small>${h(info.detail)}</small>
                    </div>
                    <button data-action="dashboard-widget-hide" data-id="${h(widget.id)}">隐藏</button>
                  </article>
                `;
              })
              .join("")}</div>`
          : `<div class="empty">状态小卡片已全部隐藏。</div>`
      }
      ${
        hidden.length
          ? `<div class="hidden-widgets">${hidden
              .map(
                (widget) =>
                  `<button data-action="dashboard-widget-show" data-id="${h(widget.id)}">显示 ${h(widget.title)}</button>`
              )
              .join("")}</div>`
          : ""
      }
    </section>
  `;
}

function renderCards() {
  return `
    <section class="bookmark-board nav-section">
      ${cardGroups()
        .map(
          ([group, cards]) => `
            <div class="bookmark-group">
              <div class="bookmark-group-head">
                <h3>${h(group)}</h3>
                <button class="bookmark-round" title="添加书签" data-action="card-add" data-group="${h(group)}">＋</button>
                <button class="bookmark-round" title="分组设置" data-action="card-group-settings" data-group="${h(group)}">⚙</button>
              </div>
              ${
                cards.length
                  ? `<div class="bookmark-grid">${cards.map(renderBookmarkCard).join("")}</div>`
                  : `<div class="bookmark-empty">这个分组还没有书签。</div>`
              }
            </div>
          `
        )
        .join("")}
      <input class="hidden-input" id="cardIconUpload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
    </section>
  `;
}

function renderBookmarkCard(card) {
  const description = String(card.description || "").split("\n").filter(Boolean).slice(0, 2).join(" / ");
  return `
    <button
      class="bookmark-card ${h(cardSize(card))} ${h(cardStyle(card))}"
      data-card-id="${h(card.id)}"
      data-action="card-open-default"
      style="--bookmark-card-bg:${h(card.card_color || "#ffffff")};--bookmark-title-color:${h(card.title_color || "#111827")};--bookmark-accent:${h(card.color || "#2f80ed")}"
      title="${h(card.title)}"
    >
      <span class="bookmark-icon">${cardIconMarkup(card)}</span>
      <span class="bookmark-card-copy">
        <strong>${h(card.title)}</strong>
        ${cardSize(card) === "large" && description ? `<small>${h(description)}</small>` : ""}
      </span>
    </button>
  `;
}

function renderCardContextMenu() {
  if (!state.cardContextMenu.open) return "";
  const card = cardById(state.cardContextMenu.id);
  if (!card) return "";
  return `
    <div
      class="bookmark-context-menu"
      style="left:${Math.max(8, state.cardContextMenu.x)}px;top:${Math.max(8, state.cardContextMenu.y)}px"
      role="menu"
    >
      ${card.internal_url ? `<button class="green" data-action="card-open-internal" data-id="${h(card.id)}">◎ <span>内网访问</span></button>` : ""}
      <button class="blue" data-action="card-open-external" data-id="${h(card.id)}">🔗 <span>外网访问</span></button>
      <button data-action="card-edit" data-id="${h(card.id)}">✎ <span>编辑卡片</span></button>
      <button class="red" data-action="card-delete" data-id="${h(card.id)}">⌫ <span>删除卡片</span></button>
    </div>
  `;
}

function renderCardModal() {
  if (!state.cardModal.open || !state.editingCard) return "";
  const card = state.editingCard;
  const title = card.id ? "修改项目" : "添加项目";
  return `
    <div class="card-modal-backdrop" id="cardModal">
      <form id="cardForm" class="card-modal">
        <div class="card-modal-head">
          <h3>${title}</h3>
          <div class="card-modal-head-tools">
            <input name="group_name" value="${h(card.group_name || "Docker")}" placeholder="分组" />
            <span></span>
            <label class="switch-label">公开 <input type="checkbox" checked disabled /><i></i></label>
            <button type="button" data-action="card-cancel">×</button>
          </div>
        </div>
        <div class="card-modal-body">
          <div class="card-modal-grid">
            <label class="field wide">
              <span>标题 *</span>
              <input name="title" value="${h(card.title || "")}" required />
            </label>
            <label class="field">
              <span>标题颜色</span>
              <input name="title_color" type="color" value="${h(card.title_color || "#111827")}" />
            </label>
            <label class="field wide">
              <span>描述（每行对应一行文字）</span>
              <textarea name="description" placeholder="第一行（上）&#10;第二行（中）&#10;第三行（下）">${h(card.description || "")}</textarea>
            </label>
            <label class="field wide">
              <span>外网链接 *</span>
              <input name="url" value="${h(card.url || "")}" placeholder="https://example.com" required />
            </label>
            <label class="field wide">
              <span>内网链接</span>
              <input name="internal_url" value="${h(card.internal_url || "")}" placeholder="http://192.168.1.200:9838" />
            </label>
          </div>
          <div class="card-modal-options">
            <label class="field">
              <span>图标文字 / Emoji</span>
              <input name="icon" value="${h(card.icon || "")}" maxlength="4" placeholder="QB" />
            </label>
            <label class="field">
              <span>图标底色</span>
              <input name="color" type="color" value="${h(card.color || "#2f80ed")}" />
            </label>
            <label class="field">
              <span>卡片颜色</span>
              <input name="card_color" type="color" value="${h(card.card_color || "#ffffff")}" />
            </label>
            <label class="field">
              <span>尺寸</span>
              <select name="size">
                <option value="small" ${cardSize(card) === "small" ? "selected" : ""}>小</option>
                <option value="medium" ${cardSize(card) === "medium" ? "selected" : ""}>中</option>
                <option value="large" ${cardSize(card) === "large" ? "selected" : ""}>大</option>
              </select>
            </label>
            <label class="field">
              <span>样式</span>
              <select name="style">
                <option value="default" ${cardStyle(card) === "default" ? "selected" : ""}>默认</option>
                <option value="soft" ${cardStyle(card) === "soft" ? "selected" : ""}>柔和</option>
                <option value="outline" ${cardStyle(card) === "outline" ? "selected" : ""}>描边</option>
              </select>
            </label>
          </div>
          <div class="card-icon-editor">
            <div>
              <h4>图标样式</h4>
              <p>支持上传图片，也可以只使用文字或 Emoji。</p>
              <div class="mini-actions">
                <button type="button" data-action="card-icon-pick">上传图片</button>
                <button type="button" data-action="card-icon-clear">清除图片</button>
              </div>
            </div>
            <div class="card-icon-preview">${cardIconMarkup(card)}</div>
          </div>
        </div>
        <div class="card-modal-foot">
          <button type="button" data-action="card-cancel">取消</button>
          <button class="primary" type="submit">${card.id ? "保存修改" : "添加项目"}</button>
        </div>
      </form>
    </div>
  `;
}

function renderContainers() {
  const stats = containerStats();
  const visibleContainers = filteredContainers();
  return `
    <section class="container-page">
      <div class="container-titlebar">
        <div>
          <h2>容器管理</h2>
          <p>管理您的 Docker 容器，包括启动、停止、重启等操作</p>
        </div>
        <div class="container-title-actions">
          <button class="bulk-button" data-action="container-bulk-check">检查更新</button>
          <button class="refresh-button" data-action="refresh"><span>↻</span>刷新</button>
        </div>
      </div>
      <div class="container-statbar">
        <button class="container-stat ${state.containerFilter === "all" ? "active" : ""}" data-action="container-filter" data-filter="all"><strong>${stats.total}</strong><span>总容器</span></button>
        <button class="container-stat ${state.containerFilter === "running" ? "active" : ""}" data-action="container-filter" data-filter="running"><strong class="green">${stats.running}</strong><span>运行中</span></button>
        <button class="container-stat ${state.containerFilter === "stopped" ? "active" : ""}" data-action="container-filter" data-filter="stopped"><strong class="red">${stats.stopped}</strong><span>已停止</span></button>
        <button class="container-stat ${state.containerFilter === "updates" ? "active" : ""}" data-action="container-filter" data-filter="updates"><strong class="orange">${stats.updates}</strong><span>有更新</span></button>
      </div>
      <div class="container-filter-label">
        ${h(containerFilterTitle())} · ${visibleContainers.length} 个
        ${
          state.containerUpdateCheck.active
            ? `<span>正在检测更新 ${state.containerUpdateCheck.done}/${state.containerUpdateCheck.total}</span>`
            : ""
        }
      </div>
      ${
        state.containers.length
          ? state.containerView === "table"
            ? renderContainerTable(visibleContainers)
            : renderContainerCards(visibleContainers)
          : `<div class="empty">Docker 没有返回容器。请到“设置”里检查 Docker socket。</div>`
      }
      <input class="hidden-input" id="containerIconUpload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
    </section>
    ${state.containerDetail ? renderContainerDetail() : ""}
    ${state.logs.text ? `<div class="panel" style="margin-top:16px"><div class="panel-head"><h3>日志 ${h(shortId(state.logs.id))}</h3></div><pre class="console">${h(state.logs.text)}</pre></div>` : ""}
    ${renderContainerBackups()}
  `;
}

function renderContainerCards(containers = filteredContainers()) {
  if (!containers.length) return `<div class="empty">当前筛选下没有容器。</div>`;
  return `
    <div class="container-cards">
      ${containers
        .map((item) => {
          const running = String(item.State).toLowerCase() === "running";
          const updateHot = Boolean(item.DockPilot?.update_available);
          const updating = isContainerUpdating(item.Id);
          return `
            <article class="container-card ${h(item.State)} ${updateHot ? "has-update" : ""}" style="--card-color:${h(containerColor(item))}">
              ${updateHot ? `<div class="new-ribbon">NEW</div>` : ""}
              <div class="container-card-main">
                <button class="container-icon" title="点击上传自定义图标" data-action="container-icon-pick" data-id="${h(item.Id)}" data-key="${h(containerKey(item))}">
                  ${containerIcon(item)}
                </button>
                <div class="container-card-info">
                  <div class="container-name-row">
                    <strong>${h(containerName(item))}</strong>
                    <span class="state-dot ${h(item.State)}" title="${h(zhContainerState(item.State))}"></span>
                  </div>
                  <span class="container-image">${h(containerImageName(item))}</span>
                  <span class="container-runtime">${h(containerRuntime(item))}</span>
                  ${item.DockPilot?.update_check_error ? `<span class="container-update-error">${h(zhError(item.DockPilot.update_check_error))}</span>` : ""}
                </div>
              </div>
              <div class="container-card-divider"></div>
              ${renderContainerCardUpdateProgress(item.Id)}
              <div class="container-action-row">
                <button class="container-action stop" data-action="container-command" data-command="${running ? "stop" : "start"}" data-id="${h(item.Id)}">
                  <span>□</span>${running ? "停止" : "启动"}
                </button>
                <button class="container-action restart" data-action="container-command" data-command="restart" data-id="${h(item.Id)}">
                  <span>↻</span>重启
                </button>
                <button class="container-action update ${updateHot ? "hot" : ""}" data-action="container-update" data-id="${h(item.Id)}" ${updating ? "disabled" : ""}>
                  <span>⇧</span>${updating ? "更新中" : "更新"}
                </button>
              </div>
              <div class="container-extra-actions">
                <button data-action="container-check-update" data-id="${h(item.Id)}">检查更新</button>
                <button data-action="container-backup" data-id="${h(item.Id)}">备份</button>
                <button data-action="container-inspect" data-id="${h(item.Id)}">详情</button>
                <button data-action="container-logs" data-id="${h(item.Id)}">日志</button>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderContainerTable(containers = filteredContainers()) {
  if (!containers.length) return `<div class="empty">当前筛选下没有容器。</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>ID</th><th>操作</th></tr></thead>
        <tbody>
          ${containers
            .map((item) => {
              const updating = isContainerUpdating(item.Id);
              return `
              <tr>
                <td><strong>${h(containerName(item))}</strong></td>
                <td>${h(item.Image)}</td>
                <td><span class="status ${h(item.State)}">${h(zhContainerState(item.State))}</span></td>
                <td>${h(formatPorts(item.Ports))}</td>
                <td><code>${h(shortId(item.Id))}</code></td>
                <td class="actions">
                  <button data-action="container-command" data-command="start" data-id="${h(item.Id)}">启动</button>
                  <button data-action="container-command" data-command="stop" data-id="${h(item.Id)}">停止</button>
                  <button data-action="container-command" data-command="restart" data-id="${h(item.Id)}">重启</button>
                  <button data-action="container-update" data-id="${h(item.Id)}" ${updating ? "disabled" : ""}>${updating ? "更新中" : "一键更新"}</button>
                  <button data-action="container-check-update" data-id="${h(item.Id)}">检查更新</button>
                  <button data-action="container-backup" data-id="${h(item.Id)}">备份</button>
                  <button data-action="container-inspect" data-id="${h(item.Id)}">详情</button>
                  <button data-action="container-logs" data-id="${h(item.Id)}">日志</button>
                </td>
              </tr>
            `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderContainerBackups() {
  return `
    <section class="panel detail-panel">
      <div class="panel-head">
        <div>
          <h3>容器备份</h3>
          <span class="muted">备份会保存容器配置和可恢复的 compose.yml。恢复时创建新 Compose 项目，不会覆盖原容器。</span>
        </div>
        <button class="danger" data-action="container-backups-clear">一键清理</button>
      </div>
      ${
        state.containerBackups.length
          ? `<div class="backup-list">${state.containerBackups
              .map(
                (backup) => `
                <div class="backup-item">
                  <div class="backup-main">
                    <strong>${h(backup.container_name || backup.name)}</strong>
                    <span>${h(backup.image || "未记录镜像")}</span>
                    <small>${h(backup.created_at || "-")} · ${fmtBytes(backup.size || 0)}</small>
                  </div>
                  <div class="backup-actions">
                    <button data-action="container-restore" data-name="${h(backup.name)}">恢复</button>
                    <button class="danger" data-action="container-backup-delete" data-name="${h(backup.name)}">删除</button>
                  </div>
                </div>
              `
              )
              .join("")}</div>`
          : `<div class="empty">还没有容器备份。</div>`
      }
    </section>
  `;
}

function renderImages() {
  const images = filteredImages();
  const totalSize = state.images.items.reduce((sum, image) => sum + Number(image.Size || 0), 0);
  const searchResults = state.images.searchResults || [];
  const mirrorText = (state.images.registryMirrors || []).join("\n");
  return `
    <section class="image-library">
      <div class="panel-head">
        <div>
          <h3>镜像库</h3>
          <span class="muted">管理本地 Docker 镜像，支持搜索、拉取、删除和清理悬空镜像。</span>
        </div>
        <button data-action="image-prune">清理悬空镜像</button>
      </div>
      <div class="image-summary">
        <div><strong>${state.images.items.length}</strong><span>本地镜像</span></div>
        <div><strong>${fmtBytes(totalSize)}</strong><span>占用空间</span></div>
        <div><strong>${h(state.images.proxy || "未设置")}</strong><span>镜像加速源</span></div>
      </div>
      <div class="image-sections">
        <section class="image-tool-card accent-blue">
          <h4>镜像拉取</h4>
          <form id="imagePullForm" class="image-pull-form">
          <label class="field">
            <span>拉取镜像</span>
            <input name="image" placeholder="nginx:latest 或 ghcr.io/user/app:latest" required />
          </label>
          <label class="field">
            <span>下载方式</span>
            <select id="imagePullMode" name="pull_mode">
              <option value="proxy" ${state.images.pullMode !== "direct" ? "selected" : ""}>使用代理</option>
              <option value="direct" ${state.images.pullMode === "direct" ? "selected" : ""}>直接拉取</option>
            </select>
          </label>
          <button class="primary" type="submit">拉取</button>
          </form>
        </section>
        <section class="image-tool-card accent-green">
          <h4>搜索</h4>
          <label class="field">
            <span>本地搜索</span>
            <input id="imageSearch" value="${h(state.images.query)}" placeholder="输入镜像名、标签或 ID" />
          </label>
          <form id="imageRemoteSearchForm" class="inline-form">
          <label class="field">
            <span>远程搜索</span>
            <input id="imageRemoteSearch" name="q" value="${h(state.images.remoteQuery)}" placeholder="搜索 Docker Hub 镜像" required />
          </label>
          <button type="submit">搜索</button>
          </form>
        </section>
        <section class="image-tool-card accent-purple">
          <h4>镜像加速源</h4>
          <form id="imageMirrorsForm" class="form-stack">
          <label class="field">
            <span>每行一个加速源</span>
            <textarea name="registry_mirrors" placeholder="docker.1ms.run&#10;docker.1panel.live">${h(mirrorText)}</textarea>
          </label>
          <button type="submit">保存加速源</button>
          </form>
        </section>
        <section class="image-tool-card accent-orange">
          <h4>镜像代理</h4>
          <form id="imageNetworkProxyForm" class="inline-form">
          <label class="field">
            <span>代理地址</span>
            <input name="network_proxy" value="${h(state.images.networkProxy)}" placeholder="例如 192.168.1.2:7890" />
          </label>
          <button type="submit">保存</button>
          </form>
          <div class="proxy-status">
            <i class="${state.images.proxyOk === true ? "ok" : state.images.proxyOk === false ? "bad" : "pending"}"></i>
            <small class="proxy-test-result">${proxyStatusText()}</small>
          </div>
        </section>
      </div>
      ${renderImagePullProgress()}
      ${
        state.images.pullOutput
          ? `<pre class="console image-output">${h(state.images.pullOutput)}</pre>`
          : ""
      }
      ${
        searchResults.length
          ? `<div class="image-search-results">${searchResults
              .map(
                (item) => `
                <article class="image-search-card">
                  <div class="image-search-copy">
                    <strong>${h(item.name)}</strong>
                    <span>${h(item.description || "暂无描述")}</span>
                    <small>${item.official ? "官方 · " : ""}${h(String(item.stars || 0))} stars · ${h(String(item.pulls || 0))} pulls</small>
                  </div>
                  <button data-action="image-pull-search" data-image="${h(item.pull_name || `${item.name}:latest`)}">拉取 latest</button>
                </article>
              `
              )
              .join("")}</div>`
          : state.images.remoteQuery
            ? `<div class="empty">远程搜索没有结果。</div>`
            : ""
      }
      ${
        images.length
          ? `<div class="image-grid">${images
              .map((image) => {
                const id = image.Id || image.ID || "";
                return `
                  <article class="image-card">
                    <div class="image-mark">IMG</div>
                    <div class="image-info">
                      <strong>${h(imageTitle(image))}</strong>
                      <small>${h(shortId(id))} · ${fmtBytes(image.Size)} · ${h(imageCreatedText(image))}</small>
                    </div>
                    <span class="image-usage ${image.DockPilot?.used ? "used" : "unused"}">${image.DockPilot?.used ? "已使用" : "未使用"}</span>
                    <button class="danger" data-action="image-remove" data-id="${h(id)}">删除</button>
                  </article>
                `;
              })
              .join("")}</div>`
          : `<div class="empty">没有匹配的镜像。</div>`
      }
    </section>
  `;
}

function renderImagePullProgress() {
  const job = state.imagePullJob;
  if (!job) return "";
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  return `
    <div class="image-pull-progress ${h(job.status || "")}">
      <div class="image-pull-progress-head">
        <strong>${h(jobProgressText(job))} · ${h(job.step || "镜像拉取")}</strong>
        <b>${progress}%</b>
      </div>
      <div class="image-pull-track"><i style="width:${progress}%"></i></div>
      <p>${h(zhError(job.error || job.message || "正在处理镜像拉取任务。"))}</p>
    </div>
  `;
}

function renderContainerDetail() {
  const detail = state.containerDetail || {};
  const config = detail.Config || {};
  const stateInfo = detail.State || {};
  const networkSettings = detail.NetworkSettings || {};
  const networks = networkSettings.Networks || {};
  const env = Array.isArray(config.Env) ? config.Env : [];
  const mounts = Array.isArray(detail.Mounts) ? detail.Mounts : [];
  return `
    <section class="panel detail-panel">
      <div class="panel-head">
        <div>
          <h3>容器详情：${h((detail.Name || "").replace(/^\//, "") || shortId(detail.Id))}</h3>
          <span class="muted">${h(config.Image || "")}</span>
        </div>
        <button data-action="container-detail-close">关闭</button>
      </div>
      <div class="detail-grid">
        <div class="detail-box"><span>状态</span><strong>${h(zhContainerState(stateInfo.Status))}</strong></div>
        <div class="detail-box"><span>启动时间</span><strong>${h(stateInfo.StartedAt || "-")}</strong></div>
        <div class="detail-box"><span>重启策略</span><strong>${h(detail.HostConfig?.RestartPolicy?.Name || "-")}</strong></div>
        <div class="detail-box"><span>网络</span><strong>${h(Object.keys(networks).join(", ") || "-")}</strong></div>
      </div>
      <div class="detail-columns">
        <div>
          <h4>挂载目录</h4>
          ${mounts.length ? `<div class="detail-list">${mounts.map((item) => `<div><b>${h(item.Destination)}</b><span>${h(item.Source || item.Name || "-")}</span></div>`).join("")}</div>` : `<div class="empty">没有挂载目录。</div>`}
        </div>
        <div>
          <h4>环境变量</h4>
          ${env.length ? `<div class="detail-list">${env.slice(0, 40).map((item) => `<div><span>${h(maskEnv(item))}</span></div>`).join("")}</div>` : `<div class="empty">没有环境变量。</div>`}
        </div>
      </div>
    </section>
  `;
}

function maskEnv(value) {
  const text = String(value || "");
  const key = text.split("=", 1)[0].toLowerCase();
  if (["password", "passwd", "token", "secret", "key"].some((word) => key.includes(word))) {
    return `${text.split("=", 1)[0]}=******`;
  }
  return text;
}

function renderCompose() {
  return `
    <div class="split compose-page">
      <section class="panel compose-panel project-panel">
        <div class="panel-head"><h3>项目列表</h3></div>
        <form class="form-stack" id="composeNewForm">
          <div class="field"><label>新建项目</label><input name="name" placeholder="nginx-demo" /></div>
          <button type="submit" class="primary">创建</button>
        </form>
        <div class="list" style="margin-top:14px">
          ${
            state.compose.projects.length
              ? state.compose.projects
                  .map(
                    (project) => `
                    <button class="list-item ${state.compose.selected === project.path ? "active" : ""}" data-action="compose-select" data-path="${h(project.path)}">
                      <span class="project-row">
                        <strong>${h(project.name)}</strong>
                        <span class="service-pill ${h(projectStateTone(project))}">${h(projectStateTone(project) === "running" ? "运行中" : projectStateTone(project) === "missing" ? "未部署" : "已停止")}</span>
                      </span>
                      <span class="compose-services">
                        ${(project.containers || [])
                          .map(
                            (item) => `
                            <span class="compose-service">
                              <i class="state-dot ${h(item.state)}"></i>
                              <b>${h(item.service)}</b>
                              <small>${h(zhServiceState(item.state))}</small>
                            </span>
                          `
                          )
                          .join("") || `<span class="muted">${h(project.services.join(", ") || "未识别到服务")}</span>`}
                      </span>
                    </button>
                  `
                  )
                  .join("")
              : `<div class="empty">配置的目录中没有找到 Compose 文件。</div>`
          }
        </div>
        <form class="form-stack command-deploy compose-panel command-panel" id="composeCommandForm">
          <div class="panel-head"><h3>命令部署</h3><span class="muted">粘贴 docker run 命令，可转为 Compose 后部署。</span></div>
          <div class="field"><label>项目名称</label><input name="name" placeholder="my-app" required /></div>
          <div class="field"><label>Docker run 命令</label><textarea name="command" placeholder="docker run -d --name app -p 8080:80 nginx:alpine" required></textarea></div>
          <div class="form-actions">
            <button type="submit" data-deploy="0">转 Compose</button>
            <button type="submit" class="primary" data-deploy="1">转 Compose 并部署</button>
          </div>
        </form>
      </section>
      <section class="panel compose-panel editor-panel">
        <div class="panel-head">
          <div>
            <h3>Compose 编辑器</h3>
            <span class="muted">${h(state.compose.selected || "请选择左侧项目")}</span>
          </div>
          <div class="top-actions">
            <button data-action="compose-action" data-command="config">检查</button>
            <button data-action="compose-repair">检查并修正</button>
            <button data-action="compose-action" data-command="pull">拉取</button>
            <button data-action="compose-action" data-command="up" class="primary">部署</button>
            <button data-action="compose-action" data-command="restart">重启</button>
            <button data-action="compose-action" data-command="logs">日志</button>
            <button data-action="compose-action" data-command="down" class="danger">停止</button>
          </div>
        </div>
        <div class="editor-shell">
          <pre id="composeHighlight" class="code-highlight" aria-hidden="true">${highlightYaml(state.compose.content)}\n</pre>
          <textarea id="composeEditor" class="code-input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">${h(state.compose.content)}</textarea>
        </div>
        <div class="toolbar"><button data-action="compose-save" class="primary">保存 compose.yml</button></div>
        ${
          state.compose.repair
            ? `<div class="compose-repair-note">
                <strong>${state.compose.repair.changed ? "已生成修正内容" : "未发现可自动修正的问题"}</strong>
                <span>${h((state.compose.repair.changes || []).join("；") || "可继续使用检查功能确认配置。")}</span>
              </div>`
            : ""
        }
        ${state.compose.output ? `<pre class="console">${h(state.compose.output)}</pre>` : ""}
      </section>
    </div>
  `;
}

function renderFiles() {
  const roots = state.files.roots;
  if (!roots.length) return `<section class="panel page-panel"><div class="empty">还没有配置文件根目录。</div></section>`;
  return `
    <section class="panel page-panel">
      <div class="panel-head">
        <div>
          <h3>文件管理</h3>
          <span class="muted">根目录会在服务端限制，不能越界访问。</span>
        </div>
      </div>
      <div class="toolbar">
        <select id="fileRootSelect" data-action="file-root">
          ${roots.map((root) => `<option value="${h(root.name)}" ${root.name === state.files.root ? "selected" : ""}>${h(root.name)}</option>`).join("")}
        </select>
        <button data-action="file-up">返回上级</button>
        <button data-action="file-new">新建文件</button>
        <button data-action="file-mkdir">新建目录</button>
        <button data-action="file-upload-pick">上传</button>
        <input class="hidden-input" id="fileUpload" type="file" />
        <div class="path">${h(state.files.path || "/")}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>名称</th><th>类型</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead>
          <tbody>
            ${state.files.items
              .map((item) => {
                const childPath = joinPath(state.files.path, item.name);
                const isDir = item.type === "dir";
                return `
                  <tr>
                    <td><strong>${h(item.name)}</strong></td>
                    <td>${item.type === "dir" ? "目录" : "文件"}</td>
                    <td>${isDir ? "-" : h(fmtBytes(item.size))}</td>
                    <td>${h(new Date(item.modified * 1000).toLocaleString())}</td>
                    <td class="actions">
                      ${
                        isDir
                          ? `<button data-action="file-open" data-path="${h(childPath)}">打开</button>`
                          : `<button data-action="file-read" data-path="${h(childPath)}">编辑</button><a href="/api/files/download?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(childPath)}"><button>下载</button></a>`
                      }
                      <button data-action="file-copy" data-path="${h(childPath)}">复制</button>
                      <button data-action="file-move" data-path="${h(childPath)}">移动</button>
                      <button data-action="file-rename" data-path="${h(childPath)}">重命名</button>
                      <button class="danger" data-action="file-delete" data-path="${h(childPath)}">删除</button>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
    ${
      state.files.editPath
        ? `<section class="panel" style="margin-top:16px">
            <div class="panel-head"><h3>${h(state.files.editPath)}</h3></div>
            <textarea id="fileEditor" spellcheck="false">${h(state.files.content)}</textarea>
            <div class="toolbar">
              <button class="primary" data-action="file-save">保存文件</button>
              <button data-action="file-close">关闭</button>
            </div>
          </section>`
        : ""
    }
  `;
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return `<div class="empty">正在加载设置...</div>`;
  const fileRoots = (settings.file_roots || []).map((root) => `${root.name}=${root.path}`).join("\n");
  const composeRoots = (settings.compose_roots || []).join("\n");
  return `
    <section class="panel page-panel">
      <form class="form-stack" id="settingsForm">
        <div class="field">
          <label>Docker socket 路径</label>
          <input name="docker_socket" value="${h(settings.docker_socket)}" />
        </div>
        <div class="field">
          <label>Compose 目录，每行一个绝对路径</label>
          <textarea name="compose_roots">${h(composeRoots)}</textarea>
        </div>
        <div class="field">
          <label>文件根目录，格式为 名称=/绝对路径</label>
          <textarea name="file_roots">${h(fileRoots)}</textarea>
        </div>
        <div class="field">
          <label>镜像代理前缀</label>
          <input name="image_registry_proxy" value="${h(settings.image_registry_proxy || "")}" placeholder="例如 docker.1ms.run" />
        </div>
        <div class="field">
          <label>局域网网络代理</label>
          <input name="network_proxy" value="${h(settings.network_proxy || "")}" placeholder="例如 192.168.1.2:7890 或 socks5://192.168.1.2:7890" />
        </div>
        <button class="primary" type="submit">保存设置</button>
      </form>
    </section>
    <section class="panel page-panel" style="margin-top:16px">
      <div class="panel-head"><h3>修改密码</h3><span class="muted">保存后会保持当前登录状态，其他旧会话会失效。</span></div>
      <form class="form-stack" id="passwordForm">
        <div class="field">
          <label>当前密码</label>
          <input name="current_password" type="password" autocomplete="current-password" required />
        </div>
        <div class="field">
          <label>新密码</label>
          <input name="new_password" type="password" autocomplete="new-password" minlength="8" required />
        </div>
        <button class="primary" type="submit">修改密码</button>
      </form>
    </section>
  `;
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "authForm") {
      const data = Object.fromEntries(new FormData(form));
      const target = state.session.setup_required ? "/api/setup" : "/api/login";
      await api(target, { method: "POST", body: data });
      state.session = await api("/api/session");
      await refreshCurrent();
    }
    if (form.id === "cardForm") {
      const data = Object.fromEntries(new FormData(form));
      if (state.cardModal.iconBase64) {
        data.icon_mime = state.cardModal.iconMime;
        data.icon_content_base64 = state.cardModal.iconBase64;
      }
      if (state.cardModal.clearIcon) data.clear_icon = true;
      if (state.editingCard) {
        if (state.editingCard.id) {
          await api(`/api/cards/${state.editingCard.id}`, { method: "PUT", body: data });
        } else {
          await api("/api/cards", { method: "POST", body: data });
        }
        closeCardModal();
      } else {
        await api("/api/cards", { method: "POST", body: data });
      }
      form.reset();
      await refreshCurrent();
    }
    if (form.id === "composeNewForm") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/compose/projects", { method: "POST", body: data });
      state.compose.selected = "";
      await refreshCurrent();
    }
    if (form.id === "composeCommandForm") {
      const data = Object.fromEntries(new FormData(form));
      const deploy = event.submitter?.dataset.deploy === "1";
      const result = await api("/api/compose/from-command", {
        method: "POST",
        body: { name: data.name, command: data.command, deploy },
      });
      state.tab = "compose";
      state.compose.selected = result.project.path;
      state.compose.output = result.output ? `$ docker compose up -d\n\n${result.output}` : "";
      form.reset();
      await refreshCurrent();
      state.error = deploy ? "命令已转为 Compose 并完成部署。" : "命令已转为 Compose 项目。";
      render();
    }
    if (form.id === "settingsForm") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/settings", {
        method: "PUT",
        body: {
          docker_socket: data.docker_socket,
          registry_mirrors: data.image_registry_proxy,
          network_proxy: data.network_proxy,
          compose_roots: data.compose_roots.split("\n").map((line) => line.trim()).filter(Boolean),
          file_roots: data.file_roots
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const index = line.indexOf("=");
              if (index <= 0) return null;
              return { name: line.slice(0, index), path: line.slice(index + 1) };
            })
            .filter(Boolean),
        },
      });
      state.files.roots = [];
      await refreshCurrent();
    }
    if (form.id === "imagePullForm") {
      const data = Object.fromEntries(new FormData(form));
      state.images.pullMode = data.pull_mode || state.images.pullMode;
      await startImagePull(data.image, state.images.pullMode !== "direct");
    }
    if (form.id === "imageRemoteSearchForm") {
      const data = Object.fromEntries(new FormData(form));
      state.images.remoteQuery = String(data.q || "").trim();
      const result = await api(`/api/docker/images/search?q=${encodeURIComponent(state.images.remoteQuery)}`);
      state.images.searchResults = result.results || [];
      state.error = state.images.searchResults.length ? `找到 ${state.images.searchResults.length} 个镜像。` : "没有找到匹配镜像。";
      render();
    }
    if (form.id === "imageMirrorsForm") {
      const data = Object.fromEntries(new FormData(form));
      const settings = state.settings || (await api("/api/settings"));
      await api("/api/settings", {
        method: "PUT",
        body: {
          docker_socket: settings.docker_socket || "/var/run/docker.sock",
          registry_mirrors: data.registry_mirrors,
          network_proxy: state.images.networkProxy || settings.network_proxy || "",
          compose_roots: settings.compose_roots || [],
          file_roots: settings.file_roots || [],
        },
      });
      state.images.registryMirrors = data.registry_mirrors.split("\n").map((line) => line.trim()).filter(Boolean);
      state.images.proxy = state.images.registryMirrors[0] || "";
      state.settings = { ...settings, registry_mirrors: state.images.registryMirrors, image_registry_proxy: state.images.proxy };
      state.error = "镜像加速源已保存。";
      render();
    }
    if (form.id === "imageNetworkProxyForm") {
      const data = Object.fromEntries(new FormData(form));
      const settings = state.settings || (await api("/api/settings"));
      await api("/api/settings", {
        method: "PUT",
        body: {
          docker_socket: settings.docker_socket || "/var/run/docker.sock",
          registry_mirrors: state.images.registryMirrors || settings.registry_mirrors || [],
          network_proxy: data.network_proxy,
          compose_roots: settings.compose_roots || [],
          file_roots: settings.file_roots || [],
        },
      });
      state.images.networkProxy = data.network_proxy || "";
      state.images.proxyOk = null;
      state.settings = { ...settings, network_proxy: state.images.networkProxy };
      state.error = "局域网网络代理已保存。";
      scheduleImageProxyTest();
      render();
    }
    if (form.id === "passwordForm") {
      const data = Object.fromEntries(new FormData(form));
      if (data.new_password.length < 8) throw new Error("密码至少需要 8 个字符。");
      await api("/api/account/password", { method: "POST", body: data });
      form.reset();
      state.error = "密码已修改。";
      render();
    }
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    if (state.cardContextMenu.open) {
      closeCardContextMenu();
      render();
    }
    return;
  }
  const action = button.dataset.action;
  try {
    if (action === "nav") {
      state.tab = button.dataset.tab;
      await refreshCurrent();
    }
    if (action === "sidebar-toggle") {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      render();
    }
    if (action === "refresh") await refreshCurrent();
    if (action === "container-view") {
      state.containerView = button.dataset.view;
      render();
    }
    if (action === "container-filter") {
      state.containerFilter = button.dataset.filter || "all";
      render();
    }
    if (action === "container-bulk-check") {
      if (!state.containers.length) return;
      if (confirm("批量操作会依次检查所有容器镜像是否有更新，继续吗？")) {
        await checkContainerUpdates(state.containers, { force: true });
      }
    }
    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      state.session = await api("/api/session");
      render();
    }
    if (action === "card-add") {
      openCardModal(null, button.dataset.group || "Docker");
      render();
    }
    if (action === "card-open-default") {
      const card = cardById(button.dataset.cardId || button.dataset.id);
      const url = card ? cardDefaultUrl(card) : "";
      if (url) window.open(url, "_blank", "noreferrer");
      closeCardContextMenu();
    }
    if (action === "card-open-internal" || action === "card-open-external") {
      const card = cardById(button.dataset.id);
      const url = action === "card-open-internal" ? card?.internal_url : card?.url;
      if (url) window.open(url, "_blank", "noreferrer");
      closeCardContextMenu();
      render();
    }
    if (action === "card-delete") {
      if (confirm("确定删除这个导航卡片吗？")) {
        await api(`/api/cards/${button.dataset.id}`, { method: "DELETE" });
        if (state.editingCard?.id === Number(button.dataset.id)) state.editingCard = null;
        closeCardContextMenu();
        await refreshCurrent();
      }
    }
    if (action === "card-edit") {
      const card = state.cards.find((item) => item.id === Number(button.dataset.id));
      if (card) {
        openCardModal(card, card.group_name);
        render();
      }
    }
    if (action === "card-group-settings") {
      const oldGroup = button.dataset.group || "Docker";
      const nextGroup = prompt("修改分组名称", oldGroup);
      if (nextGroup && nextGroup.trim() && nextGroup.trim() !== oldGroup) {
        const targets = state.cards.filter((card) => (card.group_name || "应用") === oldGroup);
        for (const card of targets) {
          await api(`/api/cards/${card.id}`, { method: "PUT", body: { group_name: nextGroup.trim() } });
        }
        await refreshCurrent();
      }
    }
    if (action === "card-cancel") {
      closeCardModal();
      render();
    }
    if (action === "card-icon-pick") {
      document.getElementById("cardIconUpload")?.click();
    }
    if (action === "card-icon-clear") {
      if (state.editingCard) state.editingCard.icon_data = "";
      state.cardModal.clearIcon = true;
      state.cardModal.iconMime = "";
      state.cardModal.iconBase64 = "";
      render();
    }
    if (action === "container-command") {
      await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/${button.dataset.command}`, { method: "POST" });
      await refreshCurrent();
    }
    if (action === "container-logs") {
      const data = await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/logs`);
      state.logs = { id: button.dataset.id, text: data.logs || "" };
      render();
    }
    if (action === "container-check-update") {
      const data = await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/check-update`, { method: "POST" });
      updateContainerCheckState(button.dataset.id, data);
      const message = data.ok
        ? data.update_available
          ? "发现可更新镜像。"
          : "当前镜像没有检测到更新。"
        : zhError(data.message || "检查更新失败。");
      state.error = message;
      render();
    }
    if (action === "container-update") {
      if (confirm("一键更新会先备份当前容器配置，然后拉取镜像并重建容器。继续吗？")) {
        await startContainerUpdate(button.dataset.id);
      }
    }
    if (action === "container-icon-pick") {
      const input = document.getElementById("containerIconUpload");
      if (input) {
        input.dataset.id = button.dataset.id;
        input.dataset.key = button.dataset.key;
        input.click();
      }
    }
    if (action === "container-backup") {
      const data = await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/backup`, { method: "POST" });
      await refreshCurrent();
      state.error = `备份已创建：${data.backup.name}`;
      render();
    }
    if (action === "container-restore") {
      if (confirm("恢复会创建一个新的 Compose 项目，不会覆盖原容器。继续吗？")) {
        const data = await api(`/api/docker/backups/${encodeURIComponent(button.dataset.name)}`, { method: "POST" });
        state.tab = "compose";
        state.compose.selected = data.project.path;
        state.error = "已恢复为 Compose 项目，可检查后再启动。";
        await refreshCurrent();
      }
    }
    if (action === "container-backup-delete") {
      if (confirm("确定删除这个容器备份吗？")) {
        await api(`/api/docker/backups/${encodeURIComponent(button.dataset.name)}`, { method: "DELETE" });
        state.containerBackups = state.containerBackups.filter((backup) => backup.name !== button.dataset.name);
        state.error = "备份已删除。";
        render();
      }
    }
    if (action === "container-backups-clear") {
      if (confirm("确定清理全部容器更新备份吗？此操作不可恢复。")) {
        const data = await api("/api/docker/backups/clear", { method: "DELETE" });
        state.containerBackups = [];
        state.error = `已清理 ${data.deleted || 0} 个容器备份。`;
        render();
      }
    }
    if (action === "container-inspect") {
      const data = await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/inspect`);
      state.containerDetail = data.container;
      render();
    }
    if (action === "container-detail-close") {
      state.containerDetail = null;
      render();
    }
    if (action === "image-prune") {
      if (confirm("确定清理未使用的悬空镜像吗？")) {
        const data = await api("/api/docker/images/prune", { method: "POST" });
        state.error = `清理完成，释放 ${fmtBytes(data.SpaceReclaimed || 0)}。`;
        await refreshCurrent();
      }
    }
    if (action === "image-remove") {
      if (confirm("确定删除这个镜像吗？如果镜像正在被容器使用，Docker 会拒绝删除。")) {
        await api(`/api/docker/images/${encodeURIComponent(button.dataset.id)}/remove`, { method: "DELETE" });
        state.error = "镜像已删除。";
        await refreshCurrent();
      }
    }
    if (action === "image-pull-search") {
      state.error = `已提交拉取：${button.dataset.image}`;
      await startImagePull(button.dataset.image, state.images.pullMode !== "direct");
    }
    if (action === "compose-select") {
      await selectCompose(button.dataset.path);
      render();
    }
    if (action === "compose-save") {
      await api("/api/compose/file", {
        method: "PUT",
        body: { path: state.compose.selected, content: document.getElementById("composeEditor").value },
      });
      await refreshCurrent();
    }
    if (action === "compose-repair") {
      const editor = document.getElementById("composeEditor");
      let errorText = "";
      if (state.compose.selected) {
        await api("/api/compose/file", {
          method: "PUT",
          body: { path: state.compose.selected, content: editor.value },
        });
        const checked = await api("/api/compose/action", {
          method: "POST",
          body: { path: state.compose.selected, action: "config" },
        });
        if (!checked.ok) errorText = checked.output || "";
        state.compose.output = `$ ${checked.command}\n\n${checked.output || ""}`;
      }
      const result = await api("/api/compose/repair", { method: "POST", body: { content: editor.value, error: errorText } });
      state.compose.repair = result;
      if (result.changed) {
        state.compose.content = result.content;
        state.compose.repairLines = result.repaired_lines || [];
        editor.value = result.content;
        syncComposeHighlight();
        state.error = "已修正编辑器内容，请检查后再保存或部署。";
      } else {
        state.compose.repairLines = [];
        state.error = "未发现可自动修正的问题。";
      }
      render();
    }
    if (action === "compose-action") {
      if (!state.compose.selected) throw new Error("请先选择一个 Compose 项目。");
      await api("/api/compose/file", {
        method: "PUT",
        body: { path: state.compose.selected, content: document.getElementById("composeEditor").value },
      });
      const data = await api("/api/compose/action", {
        method: "POST",
        body: { path: state.compose.selected, action: button.dataset.command },
      });
      state.compose.output = `$ ${data.command}\n\n${data.output || ""}`;
      await loadCompose();
      render();
    }
    if (action === "file-open") {
      state.files.path = button.dataset.path;
      state.files.editPath = "";
      await refreshCurrent();
    }
    if (action === "file-up") {
      state.files.path = parentPath(state.files.path);
      await refreshCurrent();
    }
    if (action === "file-read") {
      const data = await api(
        `/api/files/read?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(button.dataset.path)}`
      );
      state.files.editPath = button.dataset.path;
      state.files.content = data.content || "";
      render();
    }
    if (action === "file-save") {
      await api("/api/files/write", {
        method: "PUT",
        body: { root: state.files.root, path: state.files.editPath, content: document.getElementById("fileEditor").value },
      });
      await refreshCurrent();
    }
    if (action === "file-close") {
      state.files.editPath = "";
      state.files.content = "";
      render();
    }
    if (action === "file-new") {
      const name = prompt("请输入新文件名");
      if (name) {
        state.files.editPath = joinPath(state.files.path, name);
        state.files.content = "";
        render();
      }
    }
    if (action === "file-mkdir") {
      const name = prompt("请输入新目录名");
      if (name) {
        await api("/api/files/mkdir", { method: "POST", body: { root: state.files.root, path: state.files.path, name } });
        await refreshCurrent();
      }
    }
    if (action === "file-rename") {
      const newName = prompt("请输入新名称");
      if (newName) {
        await api("/api/files/rename", {
          method: "POST",
          body: { root: state.files.root, path: button.dataset.path, new_name: newName },
        });
        await refreshCurrent();
      }
    }
    if (action === "file-copy" || action === "file-move") {
      const suffix = action === "file-copy" ? "-copy" : "";
      const defaultPath = `${button.dataset.path}${suffix}`;
      const destination = prompt("请输入目标相对路径", defaultPath);
      if (destination) {
        await api(action === "file-copy" ? "/api/files/copy" : "/api/files/move", {
          method: "POST",
          body: {
            root: state.files.root,
            path: button.dataset.path,
            destination_root: state.files.root,
            destination_path: destination,
          },
        });
        if (action === "file-move" && state.files.editPath === button.dataset.path) {
          state.files.editPath = "";
          state.files.content = "";
        }
        await refreshCurrent();
      }
    }
    if (action === "file-delete") {
      if (confirm(`确定删除 ${button.dataset.path} 吗？`)) {
        await api(
          `/api/files/delete?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(button.dataset.path)}`,
          { method: "DELETE" }
        );
        await refreshCurrent();
      }
    }
    if (action === "file-upload-pick") {
      document.getElementById("fileUpload").click();
    }
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener("contextmenu", (event) => {
  const cardNode = event.target.closest("[data-card-id]");
  if (!cardNode || state.tab !== "dashboard") return;
  event.preventDefault();
  state.cardContextMenu = {
    open: true,
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 210),
    id: Number(cardNode.dataset.cardId),
  };
  render();
});

document.addEventListener("change", async (event) => {
  try {
    if (event.target.id === "imagePullMode") {
      state.images.pullMode = event.target.value;
    }
    if (event.target.id === "fileRootSelect") {
      state.files.root = event.target.value;
      state.files.path = "";
      state.files.editPath = "";
      await refreshCurrent();
    }
    if (event.target.id === "fileUpload") {
      const file = event.target.files[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      await api("/api/files/upload", {
        method: "POST",
        body: {
          root: state.files.root,
          path: state.files.path,
          name: file.name,
          content_base64: bytesToBase64(buffer),
        },
      });
      event.target.value = "";
      await refreshCurrent();
    }
    if (event.target.id === "containerIconUpload") {
      const file = event.target.files[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      await api(`/api/docker/containers/${encodeURIComponent(event.target.dataset.id)}/pref`, {
        method: "POST",
        body: {
          container_key: event.target.dataset.key,
          icon_mime: file.type,
          icon_content_base64: bytesToBase64(buffer),
        },
      });
      event.target.value = "";
      await refreshCurrent();
      state.error = "容器图标已更新。";
      render();
    }
    if (event.target.id === "cardIconUpload") {
      const file = event.target.files[0];
      if (!file || !state.editingCard) return;
      const buffer = await file.arrayBuffer();
      const base64 = bytesToBase64(buffer);
      state.cardModal.iconMime = file.type;
      state.cardModal.iconBase64 = base64;
      state.cardModal.clearIcon = false;
      state.editingCard.icon_data = `data:${file.type};base64,${base64}`;
      event.target.value = "";
      render();
    }
    if (event.target.dataset.action === "container-color") {
      await api(`/api/docker/containers/${encodeURIComponent(event.target.dataset.id)}/pref`, {
        method: "POST",
        body: { container_key: event.target.dataset.key, color: event.target.value },
      });
      await refreshCurrent();
    }
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "imageSearch") {
    state.images.query = event.target.value;
    render();
  }
  if (event.target.id === "imageRemoteSearch") {
    state.images.remoteQuery = event.target.value;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "composeEditor") syncComposeHighlight();
});

document.addEventListener(
  "scroll",
  (event) => {
    if (event.target.id === "composeEditor") syncComposeHighlight();
  },
  true
);

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

boot();

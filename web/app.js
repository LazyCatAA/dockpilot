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
  images: { items: [], query: "", remoteQuery: "", searchResults: [], pullOutput: "", proxy: "", registryMirrors: [], networkProxy: "", proxyTest: "", proxyOk: null, pullMode: "proxy", configOpen: false },
  volumes: { items: [], backups: [], query: "", backupOpen: false },
  imagePullJob: null,
  containerView: "card",
  containerFilter: "all",
  containerDetail: null,
  containerUpdateJobs: {},
  containerUpdateCheck: { active: false, done: 0, total: 0, failed: 0 },
  sidebarCollapsed: false,
  logs: { id: "", text: "" },
  compose: { projects: [], selected: "", content: "", output: "", repair: null, repairLines: [], aiContent: "", backups: [], backupModal: false },
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
  ["volumes", "卷"],
  ["compose", "Compose"],
  ["files", "文件"],
  ["settings", "设置"],
];

const navGroups = [
  { title: "发现", items: [["dashboard", "首页导航", "⌂"]] },
  { title: "Docker", items: [["containers", "容器管理", "▦"], ["images", "镜像库", "◉"], ["volumes", "Docker 卷", "▣"], ["compose", "Compose", "◇"]] },
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

function syncComposeAiHighlight() {
  const preview = document.getElementById("composeAiPreview");
  if (!preview) return;
  preview.innerHTML = `${highlightYaml(state.compose.aiContent || "")}\n`;
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

function isDanglingImage(image) {
  return !imageTags(image).length;
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

function imageCardTone(image) {
  if (isDanglingImage(image)) return "dangling";
  return image.DockPilot?.used ? "used" : "unused";
}

function imageUsageLabel(image) {
  if (isDanglingImage(image)) return "悬空镜像";
  return image.DockPilot?.used ? "已使用" : "未使用";
}

function imageRegistryName(image) {
  const title = imageTitle(image);
  if (!title.includes("/")) return "Docker Hub";
  return title.split("/")[0];
}

function imageShortDigest(image) {
  const digests = image.RepoDigests || [];
  const digest = digests[0] || image.Id || image.ID || "";
  if (!digest) return "无 digest";
  const value = String(digest).includes("@") ? String(digest).split("@").pop() : String(digest);
  return value.replace(/^sha256:/, "sha256:").slice(0, 19);
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

function volumeName(volume) {
  return String(volume.Name || "");
}

function volumeCreatedText(volume) {
  const value = volume.CreatedAt || "";
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("zh-CN");
}

function volumeSize(volume) {
  return Number(volume.UsageData?.Size || 0);
}

function volumeRefCount(volume) {
  return Number(volume.UsageData?.RefCount ?? volume.DockPilot?.container_count ?? 0);
}

function volumeTone(volume) {
  return volume.DockPilot?.used || volumeRefCount(volume) > 0 ? "used" : "unused";
}

function volumeUsageLabel(volume) {
  return volumeTone(volume) === "used" ? "使用中" : "未使用";
}

function latestVolumeBackup(volumeNameValue) {
  return (state.volumes.backups || []).find((backup) => backup.volume_name === volumeNameValue) || null;
}

function filteredVolumes() {
  const query = state.volumes.query.trim().toLowerCase();
  if (!query) return state.volumes.items;
  return state.volumes.items.filter((volume) => {
    const haystack = [
      volume.Name,
      volume.Driver,
      volume.Mountpoint,
      ...(volume.Labels ? Object.entries(volume.Labels).flat() : []),
      ...((volume.DockPilot?.containers || [])),
    ]
      .join(" ")
      .toLowerCase();
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
              `<button class="${state.tab === key ? "active" : ""}" data-action="nav" data-tab="${key}" data-label="${h(label)}" title="${h(label)}">
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
    if (state.tab === "volumes") await loadVolumes();
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

async function loadVolumes() {
  const data = await api("/api/docker/volumes");
  state.volumes.items = data.volumes || [];
  state.volumes.backups = data.backups || [];
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
  if (state.compose.selected && !state.compose.projects.some((project) => project.path === state.compose.selected)) {
    state.compose.selected = "";
    state.compose.content = "";
    state.compose.aiContent = "";
    state.compose.repair = null;
    state.compose.repairLines = [];
  }
}

function resetComposeEditor() {
  state.compose.selected = "";
  state.compose.content = "";
  state.compose.aiContent = "";
  state.compose.repair = null;
  state.compose.repairLines = [];
  state.compose.output = "";
}

async function selectCompose(path) {
  state.compose.selected = path;
  const data = await api(`/api/compose/file?path=${encodeURIComponent(path)}`);
  state.compose.content = data.content || "";
  state.compose.aiContent = "";
  state.compose.repair = null;
  state.compose.repairLines = [];
}

async function loadComposeBackups() {
  const data = await api("/api/compose/backups");
  state.compose.backups = data.backups || [];
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
          ["containers", "images", "volumes", "compose"].includes(state.tab)
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
        ${state.compose.backupModal ? renderComposeBackupModal() : ""}
      </main>
    </section>
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
  if (state.tab === "volumes") return renderVolumes();
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

function renderImageGroup(title, note, items, tone) {
  if (!items.length) return "";
  return `
    <section class="image-group-section ${h(tone)}">
      <div class="image-group-head">
        <div>
          <h4>${h(title)}</h4>
          <span>${h(note)}</span>
        </div>
        <b>${items.length}</b>
      </div>
      <div class="image-compact-list">${items.map(renderImageRow).join("")}</div>
    </section>
  `;
}

function renderImageRow(image) {
  const id = image.Id || image.ID || "";
  const tone = imageCardTone(image);
  return `
    <div class="image-compact-row ${h(tone)}">
      <span class="image-status-dot ${h(tone)}"></span>
      <strong title="${h(imageTitle(image))}">${h(imageTitle(image))}</strong>
      <code title="${h(imageShortDigest(image))}">${h(imageShortDigest(image))}</code>
      <span>${fmtBytes(image.Size)}</span>
      <span class="image-usage ${h(tone)}">${imageUsageLabel(image)}</span>
      <span>${h(imageCreatedText(image))}</span>
      <button class="danger" title="删除镜像" data-action="image-remove" data-id="${h(id)}">${tone === "dangling" ? "清理" : "删除"}</button>
    </div>
  `;
}

function renderImageCard(image) {
  const id = image.Id || image.ID || "";
  const tone = imageCardTone(image);
  const title = imageTitle(image);
  const subtitle = imageSubtitle(image);
  return `
    <article class="image-card-shell ${h(tone)}">
      <div class="image-card-top">
        <div class="image-mark" aria-hidden="true">
          <span>${h(title.slice(0, 2).toUpperCase())}</span>
        </div>
        <div class="image-info">
          <div class="image-title-row">
            <strong title="${h(title)}">${h(title)}</strong>
            <span class="image-status-dot ${h(tone)}"></span>
          </div>
          <small title="${h(subtitle)}">${h(subtitle)}</small>
        </div>
      </div>
      <div class="image-facts">
        <span><b>${fmtBytes(image.Size)}</b><small>大小</small></span>
        <span><b>${h(imageCreatedText(image))}</b><small>创建</small></span>
        <span><b>${h(imageRegistryName(image))}</b><small>来源</small></span>
      </div>
      <div class="image-card-bottom">
        <span class="image-usage ${h(tone)}">${imageUsageLabel(image)}</span>
        <code>${h(imageShortDigest(image))}</code>
        <div class="image-card-actions">
          <button class="danger" title="删除镜像" data-action="image-remove" data-id="${h(id)}">删除</button>
        </div>
      </div>
    </article>
  `;
}

function renderImages() {
  const images = filteredImages();
  const totalSize = state.images.items.reduce((sum, image) => sum + Number(image.Size || 0), 0);
  const usedCount = state.images.items.filter((image) => image.DockPilot?.used && !isDanglingImage(image)).length;
  const danglingCount = state.images.items.filter(isDanglingImage).length;
  const unusedCount = Math.max(0, state.images.items.length - usedCount - danglingCount);
  const usedImages = images.filter((image) => image.DockPilot?.used && !isDanglingImage(image));
  const danglingImages = images.filter(isDanglingImage);
  const unusedImages = images.filter((image) => !image.DockPilot?.used && !isDanglingImage(image));
  const searchResults = state.images.searchResults || [];
  const mirrorText = (state.images.registryMirrors || []).join("\n");
  const totalCount = Math.max(state.images.items.length, 1);
  const usedPct = (usedCount / totalCount) * 100;
  const unusedPct = (unusedCount / totalCount) * 100;
  const danglingPct = (danglingCount / totalCount) * 100;
  return `
    <section class="image-library">
      <div class="panel-head">
        <div>
          <h3>镜像库</h3>
          <span class="muted">管理本地 Docker 镜像，支持搜索、拉取、删除和清理悬空镜像。</span>
        </div>
        <div class="top-actions">
          <button data-action="image-config-toggle">配置</button>
          <button data-action="image-prune">清理悬空镜像</button>
        </div>
      </div>
      <div class="image-command-bar">
        <form id="imagePullForm" class="image-pull-form">
          <input name="image" placeholder="拉取镜像，例如 nginx:latest" required />
          <select id="imagePullMode" name="pull_mode">
            <option value="proxy" ${state.images.pullMode !== "direct" ? "selected" : ""}>使用加速源</option>
            <option value="direct" ${state.images.pullMode === "direct" ? "selected" : ""}>直接拉取</option>
          </select>
          <button class="primary" type="submit">拉取</button>
        </form>
        <label>
          <input id="imageSearch" value="${h(state.images.query)}" placeholder="搜索本地镜像、标签或 ID" />
        </label>
        <form id="imageRemoteSearchForm" class="image-remote-form">
          <input id="imageRemoteSearch" name="q" value="${h(state.images.remoteQuery)}" placeholder="搜索 Docker Hub 镜像" required />
          <button type="submit">搜索</button>
        </form>
        <div class="image-config-status">
          <i class="${state.images.proxyOk === true ? "ok" : state.images.proxyOk === false ? "bad" : "pending"}"></i>
          <span>${h(state.images.proxy || "未设置加速源")} · ${proxyStatusText()}</span>
        </div>
      </div>
      ${
        state.images.configOpen
          ? `<div class="image-config-panel">
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
            </div>`
          : ""
      }
      <div class="image-summary-bar">
        <div><strong class="blue">${state.images.items.length}</strong><span>本地镜像</span></div>
        <div><strong class="green">${usedCount}</strong><span>已使用</span></div>
        <div><strong class="slate">${unusedCount}</strong><span>未使用</span></div>
        <div><strong class="orange">${danglingCount}</strong><span>悬空镜像</span></div>
        <div><strong class="purple">${fmtBytes(totalSize)}</strong><span>占用空间</span></div>
        <div class="image-ratio-track" title="已使用 / 未使用 / 悬空镜像比例">
          <i class="used" style="width:${usedPct}%"></i>
          <i class="unused" style="width:${unusedPct}%"></i>
          <i class="dangling" style="width:${danglingPct}%"></i>
        </div>
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
          ? `<div class="image-groups">
              ${renderImageGroup("正在使用", "被容器引用的镜像，删除前需要先处理相关容器。", usedImages, "used")}
              ${renderImageGroup("未使用", "当前没有容器引用，适合检查后清理。", unusedImages, "unused")}
              ${renderImageGroup("悬空镜像", "没有有效标签的镜像，通常来自构建或更新残留。", danglingImages, "dangling")}
            </div>`
          : `<div class="empty">没有匹配的镜像。</div>`
      }
    </section>
  `;
}

function renderVolumeGroup(title, note, items, tone) {
  if (!items.length) return "";
  return `
    <section class="image-group-section volume-group ${h(tone)}">
      <div class="image-group-head">
        <div>
          <h4>${h(title)}</h4>
          <span>${h(note)}</span>
        </div>
        <b>${items.length}</b>
      </div>
      <div class="image-grid volume-grid">${items.map(renderVolumeCard).join("")}</div>
    </section>
  `;
}

function renderVolumeCard(volume) {
  const name = volumeName(volume);
  const tone = volumeTone(volume);
  const backup = latestVolumeBackup(name);
  const containers = volume.DockPilot?.containers || [];
  return `
    <article class="image-card-shell volume-card-shell ${h(tone)}">
      <div class="image-card-top">
        <div class="image-mark volume-mark" aria-hidden="true"><span>卷</span></div>
        <div class="image-info">
          <div class="image-title-row">
            <strong title="${h(name)}">${h(name)}</strong>
            <span class="image-status-dot ${h(tone)}"></span>
          </div>
          <small title="${h(volume.Mountpoint || "未记录挂载点")}">${h(volume.Mountpoint || "未记录挂载点")}</small>
        </div>
      </div>
      <div class="image-facts volume-facts">
        <span><b>${fmtBytes(volumeSize(volume))}</b><small>大小</small></span>
        <span><b>${h(String(volumeRefCount(volume)))}</b><small>引用</small></span>
        <span><b>${h(volume.Driver || "local")}</b><small>驱动</small></span>
        <span><b>${h(volumeCreatedText(volume))}</b><small>创建</small></span>
      </div>
      <div class="volume-containers" title="${h(containers.join(", ") || "当前没有容器引用")}">
        ${containers.length ? h(containers.slice(0, 3).join("、")) : "当前没有容器引用"}
      </div>
      <div class="image-card-bottom volume-card-bottom">
        <span class="image-usage ${h(tone)}">${volumeUsageLabel(volume)}</span>
        <code>${backup ? `最近备份 ${h(backup.created_at || backup.name)}` : "还没有备份"}</code>
        <div class="image-card-actions volume-card-actions">
          <button data-action="volume-backup" data-name="${h(name)}">备份</button>
          <button data-action="volume-restore" data-name="${h(name)}" ${backup ? "" : "disabled"}>恢复</button>
          <button class="danger" data-action="volume-remove" data-name="${h(name)}" ${tone === "used" ? "disabled" : ""}>删除</button>
        </div>
      </div>
    </article>
  `;
}

function renderVolumeBackups() {
  if (!state.volumes.backupOpen) return "";
  return `
    <section class="image-config-panel volume-backup-panel">
      <section class="image-tool-card accent-purple">
        <h4>卷备份记录</h4>
        ${
          state.volumes.backups.length
            ? `<div class="backup-list volume-backup-list">${state.volumes.backups
                .map(
                  (backup) => `
                  <div class="backup-item">
                    <div class="backup-main">
                      <strong>${h(backup.volume_name || backup.name)}</strong>
                      <span>${h(backup.name)}</span>
                      <small>${h(backup.created_at || "-")} · ${fmtBytes(backup.size || 0)}</small>
                    </div>
                    <div class="backup-actions">
                      <button data-action="volume-restore-backup" data-name="${h(backup.volume_name || "")}" data-backup="${h(backup.name)}">恢复</button>
                      <button class="danger" data-action="volume-backup-delete" data-backup="${h(backup.name)}">删除</button>
                    </div>
                  </div>
                `
                )
                .join("")}</div>`
            : `<div class="empty">还没有卷备份。</div>`
        }
      </section>
    </section>
  `;
}

function renderVolumes() {
  const volumes = filteredVolumes();
  const usedVolumes = volumes.filter((volume) => volumeTone(volume) === "used");
  const unusedVolumes = volumes.filter((volume) => volumeTone(volume) !== "used");
  const totalSize = state.volumes.items.reduce((sum, volume) => sum + volumeSize(volume), 0);
  const totalCount = Math.max(state.volumes.items.length, 1);
  const usedCount = state.volumes.items.filter((volume) => volumeTone(volume) === "used").length;
  const unusedCount = Math.max(0, state.volumes.items.length - usedCount);
  const usedPct = (usedCount / totalCount) * 100;
  const unusedPct = (unusedCount / totalCount) * 100;
  return `
    <section class="image-library volume-library">
      <div class="panel-head">
        <div>
          <h3>Docker 卷</h3>
          <span class="muted">按镜像库模式管理 Docker 数据卷，支持搜索、备份、恢复和安全清理。</span>
        </div>
        <div class="top-actions">
          <button data-action="volume-backups-toggle">备份记录</button>
          <button data-action="volume-prune">清理未使用卷</button>
        </div>
      </div>
      <div class="image-command-bar volume-command-bar">
        <label>
          <input id="volumeSearch" value="${h(state.volumes.query)}" placeholder="搜索卷名、挂载点或关联容器" />
        </label>
        <div class="image-config-status">
          <i class="ok"></i>
          <span>使用中的卷默认禁止删除</span>
        </div>
      </div>
      ${renderVolumeBackups()}
      <div class="image-summary-bar volume-summary-bar">
        <div><strong class="blue">${state.volumes.items.length}</strong><span>总卷数</span></div>
        <div><strong class="green">${usedCount}</strong><span>使用中</span></div>
        <div><strong class="orange">${unusedCount}</strong><span>未使用</span></div>
        <div><strong class="purple">${fmtBytes(totalSize)}</strong><span>占用空间</span></div>
        <div><strong class="slate">${state.volumes.backups.length}</strong><span>备份记录</span></div>
        <div class="image-ratio-track" title="使用中 / 未使用比例">
          <i class="used" style="width:${usedPct}%"></i>
          <i class="dangling" style="width:${unusedPct}%"></i>
        </div>
      </div>
      ${
        volumes.length
          ? `<div class="image-groups volume-groups">
              ${renderVolumeGroup("使用中", "被容器挂载的卷，删除前需要先处理相关容器。", usedVolumes, "used")}
              ${renderVolumeGroup("未使用", "当前没有容器引用，适合检查后备份或清理。", unusedVolumes, "unused")}
            </div>`
          : `<div class="empty">没有匹配的卷。</div>`
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

function selectedComposeProject() {
  return state.compose.projects.find((project) => project.path === state.compose.selected) || null;
}

function composeStatusLabel(tone) {
  if (tone === "running") return "运行中";
  if (tone === "missing") return "未部署";
  return "已停止";
}

function composeProjectStats(projects) {
  const running = projects.filter((project) => projectStateTone(project) === "running").length;
  const missing = projects.filter((project) => projectStateTone(project) === "missing").length;
  const services = projects.reduce((sum, project) => sum + Math.max((project.containers || []).length, (project.services || []).length), 0);
  return {
    total: projects.length,
    running,
    stopped: Math.max(projects.length - running - missing, 0),
    services,
  };
}

function composeServiceItems(project) {
  if (!project) return [];
  const containers = project.containers || [];
  if (containers.length) return containers;
  return (project.services || []).map((service) => ({ service, state: "missing", image: "" }));
}

function renderComposeProjectCard(project) {
  const tone = projectStateTone(project);
  return `
    <button class="compose-project-card ${state.compose.selected === project.path ? "active" : ""} ${h(tone)}" data-action="compose-select" data-path="${h(project.path)}">
      <span>
        <strong>${h(project.name)}</strong>
      </span>
    </button>
  `;
}

function renderComposeServiceCard(item) {
  const stateValue = String(item.state || "missing").toLowerCase();
  return `
    <div class="compose-service-status-card ${h(stateValue)}">
      <div>
        <strong>${h(item.service || item.name || "service")}</strong>
        <small>${h(item.image || item.container || zhServiceState(stateValue))}</small>
      </div>
      <span class="pill ${h(stateValue)}"><i class="state-dot ${h(stateValue)}"></i>${h(zhServiceState(stateValue))}</span>
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
  const selected = selectedComposeProject();
  const stats = composeProjectStats(state.compose.projects);
  const services = composeServiceItems(selected);
  const runningServices = services.filter((item) => String(item.state || "").toLowerCase() === "running").length;
  const selectedTone = selected ? projectStateTone(selected) : "missing";
  return `
    <section class="compose-monitor-layout">
      <aside class="compose-monitor-sidebar">
        <div class="compose-monitor-title">
          <h3>Compose</h3>
          <p>以服务运行状态为中心管理 Compose 项目。</p>
        </div>
        <div class="compose-run-overview">
          <div><b>${stats.total}</b><span>项目</span></div>
          <div><b>${stats.services}</b><span>服务</span></div>
          <div><b>${stats.running}</b><span>运行中</span></div>
          <div><b>${stats.stopped}</b><span>已停止</span></div>
        </div>
        <div class="compose-project-list">
          ${
            state.compose.projects.length
              ? state.compose.projects.map(renderComposeProjectCard).join("")
              : `<div class="compose-dark-empty">配置的目录中没有找到 Compose 文件。</div>`
          }
        </div>
      </aside>
      <main class="compose-monitor-main">
        <form class="compose-inline-create" id="composeNewForm">
          <strong>新建项目</strong>
          <input name="name" placeholder="输入项目名，例如 nginx-demo" required />
          <button type="submit" class="primary">创建空白编辑窗口</button>
        </form>
        <div class="compose-monitor-head">
          <div>
            <h3>${h(selected?.name || "新建 compose.yml")}</h3>
            <span>${h(state.compose.selected || "当前为空白编辑窗口，请先在上方创建项目，或从左侧选择已有项目。")}</span>
          </div>
          <div class="top-actions compose-action-bar">
            <button data-action="compose-action" data-command="config" ${state.compose.selected ? "" : "disabled"}>检查</button>
            <button data-action="compose-repair">AI 修正</button>
            <button data-action="compose-convert-command-ai">AI 转 Compose</button>
            <button data-action="compose-apply-ai" ${state.compose.aiContent ? "" : "disabled"}>应用 AI 修正</button>
            <button data-action="compose-backup" ${state.compose.selected ? "" : "disabled"}>备份</button>
            <button data-action="compose-restore">恢复</button>
            <button data-action="compose-save" class="primary" ${state.compose.selected ? "" : "disabled"}>保存</button>
            <button data-action="compose-action" data-command="pull" ${state.compose.selected ? "" : "disabled"}>拉取</button>
            <button data-action="compose-action" data-command="up" class="primary" ${state.compose.selected ? "" : "disabled"}>部署</button>
            <button data-action="compose-action" data-command="restart" ${state.compose.selected ? "" : "disabled"}>重启</button>
            <button data-action="compose-action" data-command="down" class="danger" ${state.compose.selected ? "" : "disabled"}>停止</button>
          </div>
        </div>
        <div class="compose-status-strip">
          <div>
            <b>${runningServices}/${services.length || 0}</b>
            <span>服务在线</span>
          </div>
          <div>
            <b>${h(composeStatusLabel(selectedTone))}</b>
            <span>项目状态</span>
          </div>
          <div>
            <b>${h(services[0]?.service || "-")}</b>
            <span>主服务</span>
          </div>
          <div>
            <b>${h(state.compose.repair?.changed ? "有修正" : "正常")}</b>
            <span>修正状态</span>
          </div>
        </div>
        <div class="compose-monitor-grid">
          <section class="compose-code-panel">
            <div class="compose-panel-caption">
              <strong>compose.yml</strong>
            </div>
            <div class="editor-shell compose-dark-editor">
              <pre id="composeHighlight" class="code-highlight" aria-hidden="true">${highlightYaml(state.compose.content)}\n</pre>
              <textarea id="composeEditor" class="code-input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="粘贴 compose.yml，或粘贴 docker run 命令后点击 AI 转 Compose">${h(state.compose.content)}</textarea>
            </div>
            <div class="compose-repair-note compose-dark-note compose-note-spacer" aria-hidden="true"></div>
          </section>
          <aside class="compose-runtime-panel">
            <div class="compose-panel-caption">
              <strong>AI 修正预览</strong>
            </div>
            <div class="editor-shell compose-ai-preview-shell">
              <pre id="composeAiPreview" class="code-highlight compose-ai-preview">${state.compose.aiContent ? highlightYaml(state.compose.aiContent) : "点击 AI 修正后，这里会显示修正后的 compose.yml。"}\n</pre>
            </div>
            ${
              state.compose.repair
                ? `<div class="compose-repair-note compose-dark-note">
                    <strong>${state.compose.repair.changed ? "AI 已生成修正内容" : "AI 返回内容未变化"}</strong>
                    <span>${h((state.compose.repair.changes || []).join("；") || "可继续使用检查功能确认配置。")}</span>
                  </div>`
                : `<div class="compose-repair-note compose-dark-note">
                    <strong>AI 修正要求</strong>
                    <span>AI 只允许修正格式，不应改变服务、镜像、端口含义、挂载路径和环境变量含义。</span>
                  </div>`
            }
          </aside>
        </div>
        <section class="compose-terminal-panel">
          <div class="compose-terminal-tabs">
            <span class="active">日志 / 输出</span>
            <span>检查</span>
            <span>修正</span>
            <span>事件</span>
          </div>
          <pre class="console compose-dark-console">${h(state.compose.output || "$ docker compose ps\n等待执行检查、部署或日志命令。")}</pre>
        </section>
      </main>
    </div>
  `;
}

function renderComposeBackupModal() {
  const currentPath = state.compose.selected;
  const backups = state.compose.backups || [];
  return `
    <div class="modal-backdrop" data-action="compose-backup-close">
      <div class="compose-backup-modal">
        <div class="panel-head">
          <div>
            <h3>恢复 Compose 备份</h3>
            <span class="muted">选择备份后可先预览，再恢复到当前项目或恢复为新项目。</span>
          </div>
          <button type="button" data-action="compose-backup-close">关闭</button>
        </div>
        <div class="compose-backup-list">
          ${
            backups.length
              ? backups.map((item) => `
                  <div class="compose-backup-item">
                    <div>
                      <strong>${h(item.project_name || "compose")}</strong>
                      <span>${h(item.created_at || item.name)} · ${fmtBytes(item.size || 0)}</span>
                      ${item.note ? `<small>${h(item.note)}</small>` : ""}
                    </div>
                    <div class="mini-actions">
                      <button data-action="compose-backup-preview" data-name="${h(item.name)}">预览</button>
                      <button data-action="compose-backup-restore" data-name="${h(item.name)}" ${currentPath ? "" : "disabled"}>恢复到当前</button>
                      <button data-action="compose-backup-restore-new" data-name="${h(item.name)}">恢复为新项目</button>
                      <button class="danger" data-action="compose-backup-delete" data-name="${h(item.name)}">删除</button>
                    </div>
                  </div>
                `).join("")
              : `<div class="empty">还没有 Compose 备份。</div>`
          }
        </div>
      </div>
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
      <form class="settings-grid-form" id="settingsForm">
        <section class="settings-card">
          <h4>基础路径</h4>
          <label class="field"><span>Docker socket 路径</span><input name="docker_socket" value="${h(settings.docker_socket)}" /></label>
          <label class="field"><span>Compose 目录</span><textarea name="compose_roots">${h(composeRoots)}</textarea></label>
          <label class="field"><span>文件根目录</span><textarea name="file_roots">${h(fileRoots)}</textarea></label>
        </section>
        <section class="settings-card">
          <h4>镜像网络</h4>
          <label class="field"><span>镜像代理前缀</span><input name="image_registry_proxy" value="${h(settings.image_registry_proxy || "")}" placeholder="例如 docker.1ms.run" /></label>
          <label class="field"><span>局域网网络代理</span><input name="network_proxy" value="${h(settings.network_proxy || "")}" placeholder="例如 192.168.1.2:7890 或 socks5://192.168.1.2:7890" /></label>
        </section>
        <section class="settings-card">
          <div class="settings-card-title">
            <h4>Compose AI</h4>
            <label class="settings-switch"><input type="checkbox" name="compose_ai_enabled" value="1" ${settings.compose_ai_enabled ? "checked" : ""} /><span>启用</span></label>
          </div>
          <label class="field"><span>AI Base URL（OpenAI 兼容）</span><input name="compose_ai_base_url" value="${h(settings.compose_ai_base_url || "")}" placeholder="例如 https://api.openai.com/v1 或 http://oneapi:3000/v1" /></label>
          <label class="field"><span>AI 模型名</span><input name="compose_ai_model" value="${h(settings.compose_ai_model || "")}" placeholder="例如 gpt-4.1-mini / qwen-plus / deepseek-chat" /></label>
          <label class="field"><span>AI API Key${settings.compose_ai_api_key_set ? "（已配置，留空不修改）" : ""}</span><input name="compose_ai_api_key" type="password" autocomplete="off" placeholder="${settings.compose_ai_api_key_set ? "已配置，留空不修改" : "请输入 API Key"}" /></label>
        </section>
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
      const result = await api("/api/compose/projects", { method: "POST", body: data });
      state.compose.selected = result.project.path;
      state.compose.output = "";
      state.compose.aiContent = "";
      state.compose.repair = null;
      state.compose.repairLines = [];
      form.reset();
      await refreshCurrent();
      await selectCompose(result.project.path);
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
          compose_ai_enabled: data.compose_ai_enabled === "1",
          compose_ai_base_url: data.compose_ai_base_url,
          compose_ai_model: data.compose_ai_model,
          compose_ai_api_key: data.compose_ai_api_key,
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
          compose_ai_enabled: settings.compose_ai_enabled || false,
          compose_ai_base_url: settings.compose_ai_base_url || "",
          compose_ai_model: settings.compose_ai_model || "",
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
          compose_ai_enabled: settings.compose_ai_enabled || false,
          compose_ai_base_url: settings.compose_ai_base_url || "",
          compose_ai_model: settings.compose_ai_model || "",
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
      if (state.tab === "compose") resetComposeEditor();
      await refreshCurrent();
    }
    if (action === "sidebar-toggle") {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      render();
    }
    if (action === "refresh") await refreshCurrent();
    if (action === "image-config-toggle") {
      state.images.configOpen = !state.images.configOpen;
      render();
    }
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
        await selectCompose(data.project.path);
        render();
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
    if (action === "volume-backups-toggle") {
      state.volumes.backupOpen = !state.volumes.backupOpen;
      render();
    }
    if (action === "volume-prune") {
      if (confirm("确定清理全部未使用 Docker 卷吗？建议先确认不再需要这些数据。")) {
        const data = await api("/api/docker/volumes/prune", { method: "POST" });
        state.error = `清理完成，释放 ${fmtBytes(data.SpaceReclaimed || 0)}。`;
        await refreshCurrent();
      }
    }
    if (action === "volume-remove") {
      if (confirm(`确定删除卷 ${button.dataset.name} 吗？此操作会删除卷内数据。`)) {
        await api(`/api/docker/volumes/${encodeURIComponent(button.dataset.name)}/remove`, { method: "DELETE" });
        state.error = "卷已删除。";
        await refreshCurrent();
      }
    }
    if (action === "volume-backup") {
      const data = await api(`/api/docker/volumes/${encodeURIComponent(button.dataset.name)}/backup`, { method: "POST" });
      state.error = `卷备份已创建：${data.backup.name}`;
      await refreshCurrent();
    }
    if (action === "volume-restore" || action === "volume-restore-backup") {
      const sourceName = button.dataset.name || "volume";
      const backupName = button.dataset.backup || latestVolumeBackup(sourceName)?.name || "";
      if (!backupName) {
        state.error = "这个卷还没有可恢复的备份。";
        render();
      } else {
        const nextName = prompt("恢复为新卷名", `${sourceName}-restored`);
        if (nextName && nextName.trim()) {
          await api(`/api/docker/volumes/${encodeURIComponent(sourceName)}/restore-new`, {
            method: "POST",
            body: { backup: backupName, name: nextName.trim() },
          });
          state.error = `已恢复为新卷：${nextName.trim()}`;
          await refreshCurrent();
        }
      }
    }
    if (action === "volume-backup-delete") {
      if (confirm("确定删除这个卷备份吗？")) {
        await api(`/api/docker/volume-backups/${encodeURIComponent(button.dataset.backup)}/delete`, { method: "DELETE" });
        state.error = "卷备份已删除。";
        await refreshCurrent();
      }
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
    if (action === "compose-backup") {
      await api("/api/compose/backups", {
        method: "POST",
        body: { path: state.compose.selected, content: document.getElementById("composeEditor").value },
      });
      state.error = "Compose 备份已创建。";
      render();
    }
    if (action === "compose-restore") {
      await loadComposeBackups();
      state.compose.backupModal = true;
      render();
    }
    if (action === "compose-backup-close") {
      if (button.classList.contains("modal-backdrop") && event.target !== button) return;
      state.compose.backupModal = false;
      render();
    }
    if (action === "compose-backup-preview") {
      const data = await api(`/api/compose/backups/${encodeURIComponent(button.dataset.name)}`);
      state.compose.aiContent = data.backup.content || "";
      state.compose.repair = { changed: true, changes: ["已加载备份预览，请确认后应用或恢复。"] };
      state.compose.backupModal = false;
      render();
    }
    if (action === "compose-backup-restore") {
      if (!state.compose.selected) throw new Error("请先选择当前项目。");
      if (confirm("恢复会覆盖当前 compose.yml，系统会先自动备份当前内容。继续吗？")) {
        const data = await api(`/api/compose/backups/${encodeURIComponent(button.dataset.name)}/restore`, {
          method: "POST",
          body: { path: state.compose.selected },
        });
        state.compose.backupModal = false;
        await selectCompose(data.project.path);
        state.error = "已恢复到当前项目。";
        render();
      }
    }
    if (action === "compose-backup-restore-new") {
      const data = await api(`/api/compose/backups/${encodeURIComponent(button.dataset.name)}/restore-new`, { method: "POST", body: {} });
      state.compose.backupModal = false;
      state.compose.selected = data.project.path;
      await refreshCurrent();
      await selectCompose(data.project.path);
      state.error = "已恢复为新项目。";
      render();
    }
    if (action === "compose-backup-delete") {
      if (confirm("确定删除这个 Compose 备份吗？")) {
        await api(`/api/compose/backups/${encodeURIComponent(button.dataset.name)}`, { method: "DELETE" });
        await loadComposeBackups();
        render();
      }
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
        state.compose.aiContent = result.content || "";
        state.compose.repairLines = result.repaired_lines || [];
        state.error = "AI 已生成修正内容，请在右侧确认后应用。";
      } else {
        state.compose.aiContent = result.content || "";
        state.compose.repairLines = [];
        state.error = (result.changes || []).join("；") || "未发现可自动修正的问题。";
      }
      render();
    }
    if (action === "compose-convert-command-ai") {
      const editor = document.getElementById("composeEditor");
      const projectName = selectedComposeProject()?.name || "app";
      const result = await api("/api/compose/convert-command-ai", {
        method: "POST",
        body: { command: editor.value, project_name: projectName },
      });
      state.compose.repair = result;
      state.compose.aiContent = result.content || "";
      state.compose.repairLines = result.repaired_lines || [];
      state.error = "AI 已将命令转换为 Compose，请在右侧确认后应用。";
      render();
    }
    if (action === "compose-apply-ai") {
      if (!state.compose.aiContent) throw new Error("还没有 AI 修正内容。");
      state.compose.content = state.compose.aiContent;
      state.compose.repairLines = [];
      state.compose.aiContent = "";
      state.error = "已应用 AI 修正，请检查后保存或部署。";
      render();
      syncComposeHighlight();
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
  if (event.target.id === "volumeSearch") {
    state.volumes.query = event.target.value;
    render();
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

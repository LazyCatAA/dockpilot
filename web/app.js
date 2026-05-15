const state = {
  session: null,
  tab: "dashboard",
  error: "",
  loading: false,
  overview: null,
  cards: [],
  editingCard: null,
  containers: [],
  containerView: "card",
  containerDetail: null,
  logs: { id: "", text: "" },
  compose: { projects: [], selected: "", content: "", output: "" },
  files: { roots: [], root: "", path: "", items: [], editPath: "", content: "" },
  settings: null,
};

const tabs = [
  ["dashboard", "总览"],
  ["containers", "容器"],
  ["compose", "编排"],
  ["files", "文件"],
  ["settings", "设置"],
];

const navGroups = [
  { title: "发现", items: [["dashboard", "首页导航", "⌂"]] },
  { title: "Docker", items: [["containers", "容器管理", "▦"], ["compose", "编排管理", "◇"]] },
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
  state.cards = cards.cards || [];
}

async function loadContainers() {
  const data = await api("/api/docker/containers");
  state.containers = data.containers || [];
}

async function loadCompose() {
  const data = await api("/api/compose/projects");
  state.compose.projects = data.projects || [];
  if (!state.compose.selected && state.compose.projects[0]) {
    await selectCompose(state.compose.projects[0].path);
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
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">DP</div>
          <div><h1>DockPilot</h1><p>私有 NAS 控制台</p></div>
        </div>
        <nav class="nav">${renderNav()}</nav>
      </aside>
      <main class="content">
        <div class="topbar">
          <div>
            <h2>${h(pageTitle())}</h2>
            <div class="muted">当前用户：${h(state.session.user?.username || "admin")}</div>
          </div>
          <div class="top-actions">
            <button class="circle" title="刷新" data-action="refresh">⟳</button>
            <button class="circle" title="退出登录" data-action="logout">⎋</button>
          </div>
        </div>
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
  if (state.tab === "compose") return renderCompose();
  if (state.tab === "files") return renderFiles();
  if (state.tab === "settings") return renderSettings();
  return "";
}

function renderDashboard() {
  const overview = state.overview || {};
  const docker = overview.docker || {};
  const containers = overview.containers || {};
  const editing = state.editingCard;
  return `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">DockPilot</p>
        <h3>私有 NAS 与 Docker 管理面板</h3>
        <span>本机容器、Compose 项目、文件根目录和服务导航都在这里统一管理。</span>
      </div>
      <div class="hero-status ${docker.available ? "ok" : "bad"}">
        <strong>${docker.available ? "Docker 已连接" : "Docker 未连接"}</strong>
        <small>${h(zhError(docker.message || "等待检测"))}</small>
      </div>
    </section>
    <section class="metrics">
      ${renderMetric("Docker", docker.available ? "在线" : "离线", docker.available ? "本机引擎可用" : "请检查 socket", docker.available ? "green" : "red")}
      ${renderMetric("容器", `${containers.running || 0}/${containers.total || 0}`, "运行中 / 总数", "blue")}
      ${renderMetric("编排", overview.compose_projects || 0, "已发现项目", "purple")}
      ${renderMetric("导航", overview.cards || 0, "常用服务卡片", "orange")}
    </section>
    <section class="grid two">
      <div class="panel main-panel">
        <div class="panel-head"><h3>导航</h3><span class="muted">${h(zhError(docker.message || ""))}</span></div>
        ${renderCards()}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>${editing ? "编辑导航卡片" : "添加导航卡片"}</h3></div>
        <form id="cardForm" class="form-stack">
          <div class="field"><label>标题</label><input name="title" value="${h(editing?.title || "")}" required /></div>
          <div class="field"><label>访问地址</label><input name="url" value="${h(editing?.url || "")}" placeholder="https://service.local" required /></div>
          <div class="field"><label>分组</label><input name="group_name" value="${h(editing?.group_name || "应用")}" /></div>
          <div class="field"><label>短标识</label><input name="icon" value="${h(editing?.icon || "")}" maxlength="4" placeholder="APP" /></div>
          <div class="field"><label>颜色</label><input name="color" value="${h(editing?.color || "#1f6feb")}" /></div>
          <div class="form-actions">
            <button class="primary" type="submit">${editing ? "保存卡片" : "添加卡片"}</button>
            ${editing ? `<button type="button" data-action="card-cancel">取消</button>` : ""}
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderCards() {
  if (!state.cards.length) return `<div class="empty">还没有导航卡片。可以把常用服务地址添加进来。</div>`;
  const groups = state.cards.reduce((acc, card) => {
    const key = card.group_name || "应用";
    acc[key] = acc[key] || [];
    acc[key].push(card);
    return acc;
  }, {});
  return Object.entries(groups)
    .map(
      ([group, cards]) => `
      <div class="grid">
        <div class="panel-head"><h3>${h(group)}</h3></div>
        <div class="cards">
          ${cards
            .map(
              (card) => `
              <div class="card app-card">
                <div class="card-actions">
                  <a href="${h(card.url)}" target="_blank" rel="noreferrer">
                    <div class="badge" style="background:${h(card.color)}">${h(card.icon || card.title.slice(0, 2).toUpperCase())}</div>
                  </a>
                  <div class="mini-actions">
                    <button data-action="card-edit" data-id="${card.id}">编辑</button>
                    <button class="danger" data-action="card-delete" data-id="${card.id}">删除</button>
                  </div>
                </div>
                <a href="${h(card.url)}" target="_blank" rel="noreferrer"><strong>${h(card.title)}</strong></a>
                <span class="muted">${h(card.url)}</span>
              </div>
            `
            )
            .join("")}
        </div>
      </div>
    `
    )
    .join("");
}

function renderContainers() {
  return `
    <section class="panel page-panel">
      <div class="panel-head">
        <div>
          <h3>容器管理</h3>
          <span class="muted">查看状态、日志，并执行启动、停止、重启操作。</span>
        </div>
        <div class="segmented">
          <button class="${state.containerView === "card" ? "active" : ""}" data-action="container-view" data-view="card">卡片</button>
          <button class="${state.containerView === "table" ? "active" : ""}" data-action="container-view" data-view="table">列表</button>
        </div>
      </div>
      ${
        state.containers.length
          ? state.containerView === "card"
            ? renderContainerCards()
            : renderContainerTable()
          : `<div class="empty">Docker 没有返回容器。请到“设置”里检查 Docker socket。</div>`
      }
    </section>
    ${state.containerDetail ? renderContainerDetail() : ""}
    ${state.logs.text ? `<div class="panel" style="margin-top:16px"><div class="panel-head"><h3>日志 ${h(shortId(state.logs.id))}</h3></div><pre class="console">${h(state.logs.text)}</pre></div>` : ""}
  `;
}

function renderContainerCards() {
  return `
    <div class="container-cards">
      ${state.containers
        .map(
          (item) => `
          <article class="container-card">
            <div class="container-head">
              <div class="container-icon">${h(containerName(item).slice(0, 2).toUpperCase())}</div>
              <div>
                <strong>${h(containerName(item))}</strong>
                <span>${h(shortId(item.Id))}</span>
              </div>
              <span class="status ${h(item.State)}">${h(zhContainerState(item.State))}</span>
            </div>
            <div class="meta-row"><span>镜像</span><b>${h(item.Image)}</b></div>
            <div class="meta-row"><span>端口</span><b>${h(formatPorts(item.Ports))}</b></div>
            <div class="card-toolbar">
              <button data-action="container-command" data-command="start" data-id="${h(item.Id)}">启动</button>
              <button data-action="container-command" data-command="stop" data-id="${h(item.Id)}">停止</button>
              <button data-action="container-command" data-command="restart" data-id="${h(item.Id)}">重启</button>
              <button data-action="container-inspect" data-id="${h(item.Id)}">详情</button>
              <button data-action="container-logs" data-id="${h(item.Id)}">日志</button>
            </div>
          </article>
        `
        )
        .join("")}
    </div>
  `;
}

function renderContainerTable() {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>ID</th><th>操作</th></tr></thead>
        <tbody>
          ${state.containers
            .map(
              (item) => `
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
                  <button data-action="container-inspect" data-id="${h(item.Id)}">详情</button>
                  <button data-action="container-logs" data-id="${h(item.Id)}">日志</button>
                </td>
              </tr>
            `
            )
            .join("")}
        </tbody>
      </table>
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
    <div class="split">
      <section class="panel">
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
                      <strong>${h(project.name)}</strong>
                      <span class="muted">${h(project.services.join(", ") || "未识别到服务")}</span>
                    </button>
                  `
                  )
                  .join("")
              : `<div class="empty">配置的目录中没有找到 Compose 文件。</div>`
          }
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>Compose 编辑器</h3>
            <span class="muted">${h(state.compose.selected || "请选择左侧项目")}</span>
          </div>
          <div class="top-actions">
            <button data-action="compose-action" data-command="config">检查</button>
            <button data-action="compose-action" data-command="pull">拉取</button>
            <button data-action="compose-action" data-command="up" class="primary">启动</button>
            <button data-action="compose-action" data-command="restart">重启</button>
            <button data-action="compose-action" data-command="logs">日志</button>
            <button data-action="compose-action" data-command="down" class="danger">停止</button>
          </div>
        </div>
        <textarea id="composeEditor" spellcheck="false">${h(state.compose.content)}</textarea>
        <div class="toolbar"><button data-action="compose-save" class="primary">保存 compose.yml</button></div>
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
      if (state.editingCard) {
        await api(`/api/cards/${state.editingCard.id}`, { method: "PUT", body: data });
        state.editingCard = null;
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
    if (form.id === "settingsForm") {
      const data = Object.fromEntries(new FormData(form));
      await api("/api/settings", {
        method: "PUT",
        body: {
          docker_socket: data.docker_socket,
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
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "nav") {
      state.tab = button.dataset.tab;
      await refreshCurrent();
    }
    if (action === "refresh") await refreshCurrent();
    if (action === "container-view") {
      state.containerView = button.dataset.view;
      render();
    }
    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      state.session = await api("/api/session");
      render();
    }
    if (action === "card-delete") {
      if (confirm("确定删除这个导航卡片吗？")) {
        await api(`/api/cards/${button.dataset.id}`, { method: "DELETE" });
        if (state.editingCard?.id === Number(button.dataset.id)) state.editingCard = null;
        await refreshCurrent();
      }
    }
    if (action === "card-edit") {
      const card = state.cards.find((item) => item.id === Number(button.dataset.id));
      if (card) {
        state.editingCard = { ...card };
        render();
      }
    }
    if (action === "card-cancel") {
      state.editingCard = null;
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
    if (action === "container-inspect") {
      const data = await api(`/api/docker/containers/${encodeURIComponent(button.dataset.id)}/inspect`);
      state.containerDetail = data.container;
      render();
    }
    if (action === "container-detail-close") {
      state.containerDetail = null;
      render();
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

document.addEventListener("change", async (event) => {
  try {
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
  } catch (error) {
    state.error = error.message;
    render();
  }
});

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

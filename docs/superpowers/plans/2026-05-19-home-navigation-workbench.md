# Home Navigation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the DockPilot dashboard tab into a professional home navigation workbench with a top search layer and clear custom bookmark groups.

**Architecture:** Keep the current single-file frontend architecture and existing `/api/cards` plus `/api/dashboard/nav` contracts. Change only dashboard rendering, scoped dashboard CSS, smoke-test resource markers, and the cache-busting version in `web/index.html`.

**Tech Stack:** Vanilla JavaScript renderer in `web/app.js`, CSS in `web/styles.css`, Python smoke tests in `scripts/smoke_test.py`, existing Python backend unchanged.

---

### Task 1: Red Test Markers

**Files:**
- Modify: `scripts/smoke_test.py`

- [ ] **Step 1: Add failing smoke assertions**

Add assertions after the existing homepage navigation checks:

```python
assert_true("nav-workbench-command" in app_js, "首页导航应提供工作台顶部标题和全局操作区")
assert_true("nav-workbench-library-head" in app_js, "首页导航应区分书签库标题和书签过滤")
assert_true("data-action=\"card-add\" data-group=\"\"" in app_js, "首页导航顶部应提供全局新增书签入口")
assert_true("nav-workbench-search" in styles_css, "首页导航搜索框应使用独立工作台搜索样式")
assert_true("nav-workbench-group" in styles_css, "首页导航分组应使用清晰的工作台分组层级")
assert_true("linear-gradient(135deg, #1a2d73" not in styles_css, "首页导航不应继续使用深蓝渐变画布")
```

- [ ] **Step 2: Run smoke test to verify red**

Run: `python3 scripts/smoke_test.py`

Expected: FAIL because `nav-workbench-command` and related implementation markers do not exist yet.

### Task 2: Dashboard Markup

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Replace dashboard shell markup**

Change `renderDashboard()` so the dashboard section contains:

```js
<div class="nav-minimal-topbar nav-workbench-command">
  <div class="nav-workbench-title">
    <strong>${h(prefs.title || "私人导航")}</strong>
    <span>${h(prefs.subtitle || "清晰分组的服务入口，支持内外网地址和自定义图标")}</span>
  </div>
  <div class="nav-workbench-actions">
    <button class="nav-workbench-icon-button" data-action="card-add" data-group="" title="新增书签" aria-label="新增书签">...</button>
    <button class="nav-minimal-settings nav-workbench-icon-button" data-action="nav-settings-open" title="导航页设置" aria-label="导航页设置">...</button>
  </div>
</div>
```

Keep `${renderWebSearch(prefs)}` and `${renderCards()}` as separate lower sections.

- [ ] **Step 2: Update web search markup**

Give the search form both `nav-minimal-search` and `nav-workbench-search` classes and replace the text search glyph with inline SVG:

```js
<form id="webSearchForm" class="nav-minimal-search nav-workbench-search">
  <span class="nav-minimal-search-icon nav-workbench-search-icon">...</span>
```

- [ ] **Step 3: Update bookmark library markup**

Change the optional filter toolbar to:

```js
<div class="nav-minimal-library nav-reference-toolbar nav-workbench-library-head">
  <div>
    <h3>${h(prefs.section_title || "书签分组")}</h3>
    <span>每个分组可改名、调色、折叠、隐藏，并支持独立卡片密度。</span>
  </div>
  <div class="nav-minimal-library-tools">
    <input id="navSearch" value="${h(state.navSearch)}" placeholder="过滤书签" />
  </div>
</div>
```

Add `nav-workbench-group` to each rendered group section.

- [ ] **Step 4: Run syntax check**

Run: `node --check web/app.js`

Expected: PASS.

### Task 3: Workbench CSS

**Files:**
- Modify: `web/styles.css`

- [ ] **Step 1: Add scoped workbench styles**

Add a final dashboard-specific layer for `.nav-workbench-command`, `.nav-workbench-title`, `.nav-workbench-actions`, `.nav-workbench-icon-button`, `.nav-workbench-search`, `.nav-workbench-library-head`, and `.nav-workbench-group`.

Use a light workbench surface, white search/cards, clear group title rows, single-line truncation, and mobile overrides for 720px and below.

- [ ] **Step 2: Retire deep-blue dashboard canvas**

Override the current `.nav-minimal` dashboard background so it no longer contains:

```css
linear-gradient(135deg, #1a2d73 0%, #27469c 42%, #3158b7 100%)
```

Expected replacement: light blue-gray grid plus white translucent surface.

- [ ] **Step 3: Run CSS smoke check**

Run: `git diff --check -- web/styles.css`

Expected: PASS.

### Task 4: Cache Version and Verification

**Files:**
- Modify: `web/index.html`
- Modify: `scripts/smoke_test.py`

- [ ] **Step 1: Increment asset version**

Change all `20260519-63` resource versions in `web/index.html` to `20260519-64`.

- [ ] **Step 2: Sync smoke test version**

Change the smoke-test version assertions from `20260519-63` to `20260519-64`.

- [ ] **Step 3: Run full verification**

Run:

```bash
node --check web/app.js
python3 -m py_compile dockpilot/server.py scripts/smoke_test.py scripts/unit_test.py
python3 scripts/smoke_test.py
python3 scripts/unit_test.py
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 4: Commit and push**

Run:

```bash
git add web/app.js web/styles.css web/index.html scripts/smoke_test.py docs/superpowers/plans/2026-05-19-home-navigation-workbench.md
git commit -m "style: redesign home navigation workbench"
git push origin main
```

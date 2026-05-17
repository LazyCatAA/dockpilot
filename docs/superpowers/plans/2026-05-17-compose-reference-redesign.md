# Compose Reference Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild DockPilot's Compose page to visually match the provided four-column reference mockup while keeping the existing Compose API behavior.

**Architecture:** Update the existing vanilla JS renderer in `web/app.js` and the existing Compose CSS block in `web/styles.css`. Add smoke-test markers so visual structure regressions are caught without introducing a browser test framework.

**Tech Stack:** Python standard library HTTP server, SQLite, vanilla JavaScript, CSS, existing smoke and unit test scripts.

---

### Task 1: Frontend Structure Markers

**Files:**
- Modify: `scripts/smoke_test.py`
- Modify: `web/app.js`

- [ ] Add failing smoke assertions for `compose-reference-shell`, `compose-ai-issue-card`, `compose-settings-switch`, and `compose-editor-statusbar`.
- [ ] Run `python3 scripts/smoke_test.py` and confirm it fails on the missing markers.
- [ ] Rewrite `renderCompose()` to emit the reference layout shell, top toolbar, editor chrome, AI issue cards, and settings panel while preserving existing `data-action` hooks.
- [ ] Run `node --check web/app.js`.
- [ ] Run `python3 scripts/smoke_test.py` and confirm marker checks pass.

### Task 2: Reference Visual Styling

**Files:**
- Modify: `web/styles.css`

- [ ] Replace the current `.compose-reference-*` visual rules with reference-matching styles: large rounded shell, pale sidebar, compact toolbar buttons, dark editor, AI preview cards, and settings form.
- [ ] Add responsive rules for desktop, tablet, and mobile so the four-column layout collapses cleanly.
- [ ] Run `python3 scripts/smoke_test.py` to confirm CSS marker checks and existing behavior still pass.

### Task 3: Verification

**Files:**
- Review: `web/app.js`
- Review: `web/styles.css`
- Review: `scripts/smoke_test.py`

- [ ] Run `python3 -m py_compile dockpilot/server.py scripts/smoke_test.py scripts/unit_test.py`.
- [ ] Run `node --check web/app.js`.
- [ ] Run `python3 scripts/unit_test.py`.
- [ ] Run `python3 scripts/smoke_test.py`.
- [ ] Inspect `git diff` and confirm only the Compose redesign, spec, plan, and smoke markers changed.

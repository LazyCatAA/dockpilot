# Bookmark Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild DockPilot's homepage bookmarks to match the supplied FlatNas-style grouped bookmark board with right-click actions and richer card customization.

**Architecture:** Extend the existing `cards` table and `/api/cards` endpoints instead of adding a new subsystem. Keep the frontend in the existing `web/app.js` and `web/styles.css` files, replacing the inline side form with modal and context-menu state.

**Tech Stack:** Python standard library HTTP server, SQLite, vanilla JavaScript, CSS, existing smoke and unit test scripts.

---

### Task 1: Card API Fields

**Files:**
- Modify: `dockpilot/server.py`
- Modify: `scripts/smoke_test.py`

- [ ] Add a failing smoke test that creates a card with `internal_url`, `description`, `title_color`, `card_color`, `size`, `style`, and uploaded icon data, then asserts the fields are returned.
- [ ] Run `python3 scripts/smoke_test.py` and confirm it fails because the API does not preserve the new fields.
- [ ] Add SQLite migrations for the new card columns and normalize the new fields in create/update.
- [ ] Run `python3 scripts/smoke_test.py` and confirm it passes.

### Task 2: Bookmark Board UI

**Files:**
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `scripts/smoke_test.py`

- [ ] Add failing smoke assertions for frontend markers: `bookmark-board`, `bookmark-context-menu`, `cardIconUpload`, and `cardModal`.
- [ ] Run `python3 scripts/smoke_test.py` and confirm it fails on the missing markers.
- [ ] Replace the old dashboard navigation panel with the grouped bookmark board, context menu, and edit modal.
- [ ] Add CSS for the blue board, group header buttons, white bookmark pills, right-click menu, and modal.
- [ ] Run `python3 scripts/smoke_test.py` and confirm it passes.

### Task 3: Final Verification and Delivery

**Files:**
- Review all modified files.

- [ ] Run `python3 -m py_compile dockpilot/server.py scripts/smoke_test.py scripts/unit_test.py`.
- [ ] Run `node --check web/app.js`.
- [ ] Run `python3 scripts/unit_test.py`.
- [ ] Run `python3 scripts/smoke_test.py`.
- [ ] Commit the work and push to `origin/main` if all checks pass.

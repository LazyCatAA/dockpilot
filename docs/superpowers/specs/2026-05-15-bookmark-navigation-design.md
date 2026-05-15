# Bookmark Navigation Design

DockPilot 首页导航需要复刻参考图里的 FlatNas 书签板风格，同时保留当前 `cards` 数据和 API 兼容。

## Scope

- 首页导航区域改为蓝色渐变大面板，按分组显示书签。
- 分组标题右侧显示新增按钮和设置按钮，新增按钮打开该分组的书签编辑弹窗。
- 书签卡片为白色横向胶囊样式，左侧显示图片图标或文字图标，右侧显示标题。
- 右键书签卡片弹出菜单：内网访问、外网访问、编辑卡片、删除卡片。
- 编辑弹窗支持标题、描述、外网链接、内网链接、分组、标题颜色、卡片颜色、尺寸、样式、图标文字和图标图片上传。
- 卡片尺寸支持小、中、大；样式支持默认、柔和、描边。
- 旧书签继续可用，缺少新字段时使用安全默认值。

## Data Model

Extend `cards` with:

- `internal_url`: optional LAN URL used by left click when present and by context menu.
- `description`: optional description shown on large cards and stored for future use.
- `title_color`: card title color.
- `card_color`: card background color.
- `size`: `small`, `medium`, or `large`.
- `style`: `default`, `soft`, or `outline`.
- `icon_data`: uploaded icon as a data URL.

Existing `color` remains the icon/accent color so existing cards keep their current icon color.

## Testing

- Smoke test creates a card with all new fields and checks that API returns normalized values.
- Smoke test updates icon data through `/api/cards/{id}` and confirms it is persisted.
- Smoke test checks frontend assets include the new bookmark board, context menu, modal, and upload flow markers.
- Existing unit and smoke tests remain green.

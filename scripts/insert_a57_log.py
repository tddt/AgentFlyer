# -*- coding: utf-8 -*-
"""一次性脚本：向 docs/06-iteration-log.md 插入 A57 迭代日志"""
import os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
log_path = os.path.join(root, "docs", "06-iteration-log.md")

with open(log_path, "r", encoding="utf-8") as f:
    content = f.read()

a57 = """\
## 2026-04-26 · 迭代 A57 · P2-5 主题切换 — 深色(灰蓝/紫/Pink) / 浅色(橙/白/蓝)

### 本轮目标

- 完成 P2-5 最后一项：将 Console UI 的主题切换落实为「深色 = 灰蓝+紫+Pink、浅色 = 橙+白+蓝」的实际配色方案。
- 主题切换机制（`useTheme` hook + sidebar toggle 按钮）已预先存在，本轮重点是颜色体系的完整落地。

### 本轮改动

1. **src/gateway/console-ui/src/index.css** — 重写 CSS 变量层：
   - `:root`（深色）：背景 `#0c0e1c`（石青蓝）；主调色 `--af-accent: #8b5cf6`（紫-500）；副调色 `--af-accent-2: #ec4899`（pink-500）；logo 渐变 `紫 → pink`；背景光晕双色叠加（左上紫 + 右下粉）。
   - `html[data-theme="light"]`（浅色）：背景 `#fdfaf6`（暖白）；主调色 `--af-accent: #f97316`（橙-500）；副调色 `--af-accent-2: #3b82f6`（蓝-500）；logo 渐变 `橙 → 蓝`；背景光晕替换为橙+蓝。
   - 新增变量：`--af-accent` / `--af-accent-2` / `--af-accent-soft` / `--af-accent-text` / `--af-accent-text-2` / `--af-logo-grad` / `--af-logo-glow` / `--af-bg-grad` / `--af-scrollbar` / `--af-scrollbar-hover` / `--af-selection-bg` / `--af-focus-ring`
   - 滚动条、文字选中、focus 轮廓全部改为读取 CSS 变量，随主题自动切换。

2. **src/gateway/console-ui/src/components/Sidebar.tsx** — 将所有硬编码 indigo 颜色替换为 CSS 变量：
   - Logo 图标盒：`background: var(--af-logo-grad)` / `boxShadow: 0 4px 16px var(--af-logo-glow)`
   - Logo 分隔线：`borderBottom: 1px solid var(--af-border)`
   - 导航激活状态：`color: var(--af-accent-text)` + `background: var(--af-accent-soft)`；指示竖条 `background: var(--af-accent)`；图标 `color: var(--af-accent)`
   - 语言切换按钮激活高亮：同 accent soft 色系
   - 主题切换按钮：改为固定显示 accent 色背景 + accent 色图标（始终可见）

3. **src/gateway/console-ui/src/App.tsx** — 主内容区背景改为 `var(--af-bg-grad)`（随主题自动替换为紫/粉叠晕 或 橙/蓝叠晕）

### 验证结果

- `pnpm typecheck` → 0 错误
- `pnpm test` → 631/631 通过（UI 变更不影响测试）

### 影响范围

- `src/gateway/console-ui/src/index.css`
- `src/gateway/console-ui/src/components/Sidebar.tsx`
- `src/gateway/console-ui/src/App.tsx`
- `docs/10-agentos-evolution-plan.md`（P2-5 主题切换标记 ✅）
- `docs/06-iteration-log.md`

---

"""

marker = "\n## 2026-04-26 · 迭代 A56"
pos = content.find(marker)
if pos == -1:
    marker = "\n## 2026-04-26"
    pos = content.find(marker)

new_content = content[:pos + 1] + a57 + content[pos + 1:]
with open(log_path, "w", encoding="utf-8") as f:
    f.write(new_content)
print("Done, inserted A57 at pos", pos)

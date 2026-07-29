# 📁 Too Many Chats

<div align="center">

![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-orange?style=for-the-badge)
![Version](https://img.shields.io/badge/version-0.13.0-blue?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)

**Organize, search, and actually find your SillyTavern chats**

</div>

---

## ✨ Features

- **⏱️ True "last active" sort** — chats ordered by when you last touched them
  (opened / messaged / edited), not by the last message's copied date. Fresh
  branches of old chats sort to the **top**, matching the Recent screen.
- **⑂ Branch family view** — one section per lineage: the parent chat plus all
  of its branches together, ordered, with `↳ branch` chips showing parentage
  (from chat metadata, filename-pattern fallback).
- **🟠 Open-chat marker** — the chat you're in gets an accent border, an `OPEN`
  chip, a dot on its containing folder, auto-scroll on popup open, and a
  crosshair button to jump back to it anytime.
- **📂 Per-character folders** — every character card has its own independent
  folder sets, pins, and collapse states. Nothing leaks across cards.
- **🔍 Search with evidence** — matches show a highlighted context snippet of
  where your term actually appears, not just the last message.
- **🗑️ Bulk actions** — select many, move or delete many. Works in group chats.
- **✏️ Rename-safe bookkeeping** — renaming a chat (any way: pencil, welcome
  screen, slash command) carries its folder, pin, activity stamp, and family
  collapse state to the new name instead of orphaning them.
- **📌 Pins, ↕️ sorting** (activity / last-message / name / size / count),
  **🎨 folder colors**, **📱 mobile-friendly** — context menus always land
  fully on-screen, even from a kebab tap at the bottom edge of a phone.

## 📦 Installation

1. Open SillyTavern → **Extensions** → **Install Extension**
2. Paste: `https://github.com/brucestarkallen/SillyTavern-Too-Many-Chats`
3. Click **Install** and refresh

## 🚀 Usage

- **Families** button — toggle branch-lineage sections for the current character
- **Right-click** (or ⋮ on mobile) any chat — pin, rename, delete, move to folder
- **Crosshair** button — scroll back to the chat you have open
- Folder headers collapse on click; hover for rename / color / delete

## 🧪 Development

Gate (run before every push; both must pass):

```bash
cp index.js /tmp/tmc_gate.mjs && node --check /tmp/tmc_gate.mjs   # ESM parse via .mjs copy
node test_tmc.mjs                                                  # full suite, exit 1 on any failure
```

`test_tmc.mjs` extracts top-level functions from the real `index.js` by brace
counting and runs them in a jsdom sandbox — new top-level functions must be
added to the relevant extraction lists or their sandboxed callers will throw.
The suite includes a stamp-drift gate: `manifest.json` version must equal both
in-code version stamps.

## 📜 Changelog

- **0.13.0** — Deep audit against current SillyTavern source. Root fixes:
  native-block parse cache now survives ST's search behavior (current ST
  re-fetches `/api/chats/search` and **rebuilds** every block per keystroke;
  the identity-only cache missed 100% of the time — a content signature now
  decides reuse); multiple pinned chats no longer display in reverse order;
  renames migrate folder/pin/stamp/collapse bookkeeping via ST's
  `CHAT_RENAMED` event (feature-detected); context menus are viewport-clamped
  (fixed-position + client coords); searching hides empty folder/family
  sections; family sections show the open-chat dot when *any* member is open;
  deletes and card-moves share one normalized bookkeeping cleanup (the old raw
  comparison could leave ghost folder assignments); main-view 3-row truncation
  is applied before DOM is built instead of render-then-delete; stable
  `.select_chat_block_mes` preview class used before the leaf heuristic; a
  folder literally named "?" no longer vanishes from the Move-to menu;
  entering Cards mode clears bulk selection; context-menu document listeners
  are cleaned on every close path. 215 checks green, every new guard
  negative-tested.
- **0.12.2** — Hotfix for 0.12.1 (bad patch anchors).
- **0.12.1** — Contextual Move-to menu (no silent no-op entry), toasts on
  every outcome, activity-hint chip when the stamp outranks the visible date.
- **0.12.0** — Move chats between character cards; Cards browser mode.
- **0.11.0** — Deep-audit release: normalization migration, title-element
  lookup fix for current ST, proxy delete-button fall-through fix, render
  depth + scroll preservation, jump-to-open button, 4MB enrich cap.
- **0.10.0** — Branch family view (per-lineage sections, per card).
- **0.9.0** — Last-active sort via interaction stamps, `max(stamp, last-msg)`.
- **0.8.x** — Activity sort, branch chips, persisted sort; perf root fixes
  (observer scope, content-cache LRU + scoping, group preview fix).
- **0.7.0** — Observer split (mutation vs intersection), active-chat marker,
  title XSS fix.

## 📄 License

[MIT](LICENSE) — original author [chaaruze](https://github.com/chaaruze),
continued by Kristalium, this fork maintained by
[brucestarkallen](https://github.com/brucestarkallen).

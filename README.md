# 📁 Too Many Chats

<div align="center">

![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-orange?style=for-the-badge)
![Version](https://img.shields.io/badge/version-0.15.0-blue?style=for-the-badge)
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
- **🧷 Sticky section headers** — scrolling a long list always shows which
  folder or lineage you are inside.
- **🛟 Safe by construction** — bulk delete never leaves SillyTavern holding a
  deleted chat; moving a chat to another card never overwrites one that is
  already there; your scroll position survives background refreshes.

## 📦 Installation

1. Open SillyTavern → **Extensions** → **Install Extension**
2. Paste: `https://github.com/kristalium/SillyTavern-Too-Many-Chats`
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
python3 negtest.py                                                 # negative gate: every guard proven to fire
```

`test_tmc.mjs` extracts top-level functions from the real `index.js` by brace
counting and runs them in a jsdom sandbox — new top-level functions must be
added to the relevant extraction lists or their sandboxed callers will throw.
The suite includes a stamp-drift gate: `manifest.json` version must equal both
in-code version stamps.

## 📜 Changelog

- **0.15.0** — Root fixes against live ST source (server endpoints +
  bookmarks.js):
  - **Chat rows showed the wrong end of the last message.** ST's
    `/api/chats/search` builds each row's preview as the *tail* of the last
    message (server-side `getPreviewMessage`: "…" + the final 400 chars), and
    TMC's proxy rows inherited it — every chat was identified by the random
    end of the last output, while ST's own Recent Chats panel leads with the
    message's *beginning*. Rows now show the beginning of the last message,
    fetched lazily (shared 4 MB size guard, cached, fail-soft: oversized or
    unreadable chats keep the native preview), applied synchronously on
    re-renders so it never flashes back to the tail, and invalidated whenever
    a message lands so it can't go stale. During an active search the
    contextual match snippet still wins.
  - **Opening a chat fired everything twice** — two "Chat History — Loading
    chat…" banners and two full chat loads per click. Current ST opens chat
    rows through a document-delegated handler (bookmarks.js) matching
    `.select_chat_block[file_name]` — both of which TMC's proxy rows carry.
    The forwarded click on the parked native block bubbled to document and
    fired the handler once; the proxy's own click then bubbled there too and
    fired it *again*. The forwarded native click is now the single open path;
    when no live native block exists (ST rebuilt the list mid-render) the
    click still opens exactly once per build — direct-bound handlers on older
    ST, the delegated one on current ST.

- **0.14.0** — Second audit against live SillyTavern source, this time
  including the server endpoints. Root fixes:
  - **Bulk delete could corrupt an unrelated chat.** ST has two delete paths
    and they are not equivalent: the UI path calls `replaceCurrentChat()` when
    you delete the chat you are *in*, while `deleteCharacterChatByName()` /
    `deleteGroupChatByName()` only repoint the card's chat pointer and leave
    the deleted chat loaded in memory. TMC used the second kind for
    everything, so deleting the open chat left ST holding a file that no
    longer existed while saving to a *different*, live one — either tripping
    ST's integrity guard (forced page reload) or silently overwriting that
    other chat. The open chat is now deleted last, through ST's own
    chat-aware teardown, and is skipped entirely if that teardown isn't
    available on your build.
  - **Scroll position and lazy-load prefetch were both dead.** Both were
    anchored to `.shadow_select_chat_popup_body`, a class that exists in no ST
    build, so they silently fell back to an element with no overflow. Every
    background refresh threw you back to the top of the list. There is now one
    canonical scroll-container resolver, used by both.
  - **Move-to-card could overwrite a chat on the target card** — the write was
    forced (disabling the server's integrity check) and the free-name search
    couldn't see that the server sanitizes filenames after we pick one. The
    copy now carries its own integrity token, the write is no longer forced,
    and the destination is probed through the same server path the save uses.
  - **Cards button state inverted** after closing the popup while in Cards
    mode. Header toggles are no longer stored on the buttons; they are
    reconciled from real state on every render.
  - **Search highlighting** is built from DOM nodes instead of a regex over
    HTML-escaped text: searching `&` no longer splits entities apart, `<` is
    matchable at all, regex metacharacters in a term are inert, and the
    highlight colour comes from your theme (the old hardcoded white-on-pale
    was invisible on light themes).
  - **Jump-to-open now navigates.** It used to give up whenever the open chat
    wasn't currently rendered — the common case, since main view truncates
    folders to 3 rows. It drills into the holding folder or lineage first.
  - Deletes made *outside* TMC (native skull, `/delchat`, other extensions)
    now run the same bookkeeping cleanup, so folders can't keep ghost entries.
  - Locale fix: the "Last Msg" sort read a moment-formatted date cell that
    `Date.parse` cannot read on non-English installs, silently degrading to 0.
    It now falls back to the timestamp ST bakes into its own chat filenames.
  - Proxy row buttons no longer break on FontAwesome's SVG mode
    (`className.split` threw on `SVGAnimatedString`).
  - Removed a three-method date-extraction pass that ran per block per
    keystroke to fill a field nothing read; bulk folder moves now write
    settings once instead of once per chat; sticky section headers, themed
    highlight, reduced-motion support, larger touch targets on mobile.

  329 checks green; 14 guards each proven to fire by reintroducing the
  original bug (`negtest.py`).

- **0.13.1** — Full workflow-by-workflow trace of every code path. Three
  fixes: folder view keeps its header on zero-match searches (the 0.13.0
  hide-empty rule could hide the section containing the Back button — a
  blank panel with no way out); an active search now force-opens collapsed
  folders/families that hold matches, render-only (the header said "3"
  while the matching rows sat hidden; clearing the search restores your
  collapse state exactly); lazy-scroll continuation batches carry the live
  search term (rows loaded past the first slab silently lost their
  highlight and context snippets). 222 checks green, all guards
  negative-tested.

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
continued by me and [brucestarkallen](https://github.com/brucestarkallen) and everyone else

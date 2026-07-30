#!/usr/bin/env python3
"""Negative gate for v0.14.0.

AGENTS.md rule: a guard that has never failed is unproven. For every fix in
this release, reintroduce the ORIGINAL bug in a scratch tree and require that
(a) the suite exits 1 and (b) the specific assertion written for that bug is
the one that fails.

Scratch trees are built with cp, never `git checkout` — a scratch .git would
restore the COMMITTED file, not the working state under test.
"""
import io, os, shutil, subprocess, sys

SRC = os.path.dirname(os.path.abspath(__file__))
SCRATCH = '/tmp/tmc_neg'

# (label, file, original-buggy-text, current-fixed-text, expected failing assertion substring)
CASES = [
    ('N1 forced write re-enabled', 'index.js',
     "body: JSON.stringify({ avatar_url: target.avatar, file_name: destName, chat: adapted })",
     "body: JSON.stringify({ avatar_url: target.avatar, file_name: destName, chat: adapted, force: true })",
     'the write is no longer forced'),

    ('N2 destination probe removed', 'index.js',
     """        let destName = null;
        let candidate = pickFreeName(id, takenSet);
        for (let attempt = 0; attempt < 6; attempt++) {
            if (!await targetChatExists(target.avatar, candidate)) { destName = candidate; break; }
            takenSet.add(candidate); // occupied — never offer this name again
            candidate = pickFreeName(id, takenSet);
        }
        if (!destName) {
            return { ok: false, reason: 'no free name on the target card (source untouched)' };
        }
        takenSet.add(destName);""",
     """        const destName = pickFreeName(id, takenSet);
        takenSet.add(destName);""",
     'destination existence is probed'),

    ('N3 scroll target back on the non-scrolling popup', 'index.js',
     """            lastScrollTop = sameList ? (scroller.scrollTop || 0) : 0;
            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);
            scroller.scrollTop = lastScrollTop;""",
     """            lastScrollTop = sameList ? (popup.scrollTop || 0) : 0;
            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);
            popup.scrollTop = lastScrollTop;""",
     'scroll captured and restored around rebuild, on the element that actually scrolls'),

    ('N4 lazy observer rooted off the scroller', 'index.js',
     'initIntersectionObserver(scroller);',
     'initIntersectionObserver(popup);',
     'lazy observer rooted on the real scroller'),

    ('N5 Cards button paints itself again', 'index.js',
     """            cardsMode = !cardsMode;
            if (cardsMode) {""",
     """            cardsMode = !cardsMode;
            cardsBtn.classList.toggle('tmc_toggle_on', cardsMode);
            if (cardsMode) {""",
     'Cards button does not self-paint'),

    ('N6a open/other partition removed entirely', 'index.js',
     'const { others, open } = partitionOpenChat(toDelete, isActiveChatFile);',
     'const others = toDelete, open = [];',
     'bulk delete partitions on the open chat'),

    # the ordering assertion needs its own reversal: keep the partition, but
    # delete the open chat FIRST (which is what makes the repair pointless —
    # the later *ByName deletes would run against an already-repointed card).
    ('N6b open chat deleted FIRST instead of last', 'index.js',
     """                    for (const fileName of others) {
                        try {
                            await g.deleteGroupChatByName(groupId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                        } catch (err) {
                            console.warn('[TMC] deleteGroupChatByName failed for:', fileName, err);
                        }
                    }
                    for (const fileName of open) {""",
     """                    for (const fileName of open) {
                        try {
                            await g.deleteGroupChatByName(groupId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                        } catch (err) {
                            console.warn('[TMC] deleteGroupChatByName failed for:', fileName, err);
                        }
                    }
                    for (const fileName of others) {""",
     'the open chat is deleted LAST'),

    ('N7 className.split restored (SVG crash)', 'index.js',
     """                if (!selector && target.classList && target.classList.length) {
                    const parts = Array.from(target.classList)
                        .filter(c => c !== 'mes_button' && c !== 'fa-solid' && c !== 'fa');
                    if (parts.length > 0) selector = '.' + CSS.escape(parts[0]);
                }""",
     """                if (!selector && target.className) {
                    const parts = target.className.split(' ').filter(c => c !== 'mes_button' && c !== 'fa-solid' && c !== 'fa');
                    if (parts.length > 0) selector = '.' + parts[0];
                }""",
     'no className.split left'),

    ('N8 date parse back to NaN-producing form', 'index.js',
     '            const date = resolveBlockDate(dateEl ? dateEl.textContent : \'\', fileName);',
     "            const dateStr = dateEl ? dateEl.textContent : '';\n            const date = dateStr ? new Date(dateStr).getTime() : 0;",
     'the NaN-producing parse is gone'),

    ('N9 search input located positionally again', 'index.js',
     """        return popup.querySelector('#select_chat_search')
            || popup.querySelector('input[type="search"]')
            || popup.querySelector('input.search_input')
            || popup.querySelector('input[type="text"]')
            || null;""",
     """        return popup.querySelector('input[type="search"], input[type="text"], .search_input');""",
     'picks ST search box even when a text input precedes it'),

    ('N10 bulk move loops the single-chat helper', 'index.js',
     'moveChats(Array.from(selectedChats), targetFid);',
     'selectedChats.forEach(file => moveChat(file, targetFid));',
     'bulk path no longer loops moveChat'),

    ('N10b cards branch stops painting the header', 'index.js',
     """                refreshHeaderState(popup);
                // A different list entirely: don't hand its scroll offset back
                // to the per-card tree when we leave.
                lastListIdentity = 'cards';""",
     """                lastListIdentity = 'cards';""",
     'reconciliation runs on every sync path, including the cards-mode early return'),

    ('N11 external-delete cleanup removed', 'index.js',
     "for (const evName of ['CHAT_DELETED', 'GROUP_CHAT_DELETED']) {",
     "for (const evName of []) {",
     'both delete events subscribed'),

    ('N12 highlight back to an HTML string', 'index.js',
     'applyHighlight(previewEl, snippet, searchTerm);',
     "previewEl.innerHTML = splitHighlight(snippet, searchTerm).map(p => p.hit ? '<span>' + p.text + '</span>' : p.text).join('');",
     'snippet preview is no longer built via innerHTML'),
]


def run_case(label, fname, fixed, buggy, expect):
    if os.path.isdir(SCRATCH):
        shutil.rmtree(SCRATCH)
    os.makedirs(SCRATCH)
    for f in ('index.js', 'test_tmc.mjs', 'manifest.json', 'style.css'):
        shutil.copy(os.path.join(SRC, f), os.path.join(SCRATCH, f))
    os.symlink(os.path.join(SRC, 'node_modules'), os.path.join(SCRATCH, 'node_modules'))

    p = os.path.join(SCRATCH, fname)
    s = io.open(p, encoding='utf-8').read()
    if s.count(fixed) != 1:
        print(f'  SETUP FAIL {label}: anchor found {s.count(fixed)} times')
        return False
    io.open(p, 'w', encoding='utf-8').write(s.replace(fixed, buggy, 1))

    r = subprocess.run(['node', 'test_tmc.mjs'], cwd=SCRATCH,
                       capture_output=True, text=True, timeout=180)
    out = r.stdout + r.stderr
    fails = [l for l in out.splitlines() if l.strip().startswith('FAIL')]
    exited_nonzero = r.returncode != 0
    caught = any(expect in l for l in fails)
    # a crash (ReferenceError etc.) also exits 1, but that is NOT the guard firing
    if exited_nonzero and caught:
        print(f'  PASS {label} -> exit {r.returncode}, caught by: "{expect}"')
        return True
    print(f'  FAIL {label}: exit={r.returncode} caught={caught}')
    for l in fails[:5]:
        print('        saw:', l.strip())
    if not fails:
        print('        (no FAIL lines at all — the guard did not fire)')
        print('        tail:', out.strip().splitlines()[-3:])
    return False


ok = 0
print('NEGATIVE GATE — reintroducing each v0.14.0 bug\n')
for c in CASES:
    if run_case(*c):
        ok += 1
if os.path.isdir(SCRATCH):
    shutil.rmtree(SCRATCH)
print(f'\n{ok}/{len(CASES)} guards proven')
sys.exit(0 if ok == len(CASES) else 1)

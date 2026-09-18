import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const src = readFileSync('./index.js', 'utf8');
let pass = 0, fail = 0;
const assert = (cond, name) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)); };

// --- extract a top-level function body from the real source by brace counting ---
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error('not found: ' + name);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}

// comment stripper usable from the first test onward (the [6] block defines
// its own `stripComments` later; keep both rather than reorder that block)
const stripCommentsEarly = (s) => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// --- DOM + ST stubs ---
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.document = dom.window.document;

const fnSource = ['escapeHtml', 'splitHighlight', 'applyHighlight', 'getActiveChatName', 'isActiveChatFile'].map(extract).join('\n');
const api = new Function('SillyTavern', 'document', fnSource +
    '\nreturn { escapeHtml, splitHighlight, applyHighlight, getActiveChatName, isActiveChatFile };');

console.log('[1] Highlighting is a DOM operation, not an HTML string (v0.14.0)');
{
    const { splitHighlight, applyHighlight } = api({ getContext: () => ({}) }, document);
    const probe = document.createElement('div');

    // A. markup in the source text can never become markup in the DOM, and
    //    there is no escape-then-highlight ordering left to get wrong.
    const evil = '<img src=x onerror=alert(1)> chat about stuff';
    applyHighlight(probe, evil, 'chat');
    assert(probe.querySelector('img') === null, 'no <img> element ever created');
    assert(probe.textContent === evil, 'text survives byte-for-byte as literal text');
    assert(probe.querySelectorAll('span.tmc_hl').length === 1, 'highlight span applied');
    assert(probe.querySelector('span.tmc_hl').textContent === 'chat', 'span wraps exactly the match');

    // B. THE entity bug of the old regex-over-escaped-HTML path: searching a
    //    character that escapes into an entity used to slice the entity apart
    //    ("&amp;" -> "&<span>amp;</span>").
    applyHighlight(probe, 'Tom & Jerry & co', '&');
    assert(probe.textContent === 'Tom & Jerry & co', 'ampersand search leaves text intact');
    assert(probe.querySelectorAll('span.tmc_hl').length === 2, 'both ampersands highlighted');
    assert(!probe.innerHTML.includes('amp;amp;'), 'no double-escaping');

    // C. "<" was unreachable before (haystack held "&lt;", needle held "<")
    applyHighlight(probe, 'a <b> c', '<b>');
    assert(probe.querySelectorAll('span.tmc_hl').length === 1, 'angle-bracket term now matches');
    assert(probe.textContent === 'a <b> c', 'and stays text');

    // D. regex metacharacters in the term are inert by construction
    assert(splitHighlight('a.b axb', '.').filter(p => p.hit).length === 1,
        'dot is literal, not "any char"');
    assert(splitHighlight('nothing here', '(').filter(p => p.hit).length === 0,
        'unbalanced paren cannot throw or match');

    // E. purity / degenerate inputs
    assert(splitHighlight('abc', '').map(p => p.text).join('') === 'abc', 'empty term returns whole text');
    assert(splitHighlight('', 'x')[0].text === '', 'empty text is safe');
    assert(splitHighlight(null, null)[0].text === '', 'null-ish inputs are safe');
    assert(splitHighlight('aaa', 'aa').filter(p => p.hit).length === 1,
        'overlapping matches advance past the hit (no infinite loop)');
    assert(splitHighlight('xAbCx', 'abc').filter(p => p.hit)[0].text === 'AbC',
        'case-insensitive match preserves original casing');

    // NEGATIVE: the HTML-string highlighter must be gone from the source.
    assert(!src.includes('function highlightText('), 'the HTML-string highlighter no longer exists');
    assert(!src.includes('background-color: rgba(255, 255, 0, 0.3)'),
        'hardcoded inline highlight colour gone (was invisible on light themes)');
    assert(!/titleEl\.innerHTML/.test(stripCommentsEarly(extract('createProxyBlock'))),
        'title is no longer built via innerHTML');
    assert(!/previewEl\.innerHTML/.test(stripCommentsEarly(extract('enrichPreviewWithContext'))),
        'snippet preview is no longer built via innerHTML');
}

console.log('[2] isActiveChatFile: solo chat via context.chatId');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 'My Epic Chat' }) }, document);
    assert(isActiveChatFile('My Epic Chat.jsonl') === true, 'matches with .jsonl extension');
    assert(isActiveChatFile('My Epic Chat') === true, 'matches without extension');
    assert(isActiveChatFile('My Epic Chat 2.jsonl') === false, 'no prefix false-positive');
    assert(isActiveChatFile('') === false, 'empty fileName is false');
}

console.log('[3] isActiveChatFile: fallback to character card .chat field');
{
    const ctx = { chatId: undefined, characterId: 0, characters: [{ chat: 'Branch #2 - Old Story' }] };
    const { isActiveChatFile } = api({ getContext: () => ctx }, document);
    assert(isActiveChatFile('Branch #2 - Old Story.jsonl') === true, 'fallback path matches');
    assert(isActiveChatFile('Old Story.jsonl') === false, 'fallback path rejects parent chat');
}

console.log('[4] isActiveChatFile: numeric group chat_id survives String() coercion');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 1720000000000 }) }, document);
    assert(isActiveChatFile('1720000000000.jsonl') === true, 'numeric group id matches file');
}

console.log('[5] isActiveChatFile: no context -> never throws, never matches');
{
    const { isActiveChatFile } = api({ getContext: () => { throw new Error('boom'); } }, document);
    assert(isActiveChatFile('Anything.jsonl') === false, 'throwing context handled');
}

console.log('[6] Observer split: static structure of the real file');
{
    const iio = extract('initIntersectionObserver');
    const io = extract('initObserver');
    assert(iio.includes('lazyObserver.disconnect') && !iio.includes('mutationObserver'), 'initIntersectionObserver touches ONLY lazyObserver');
    assert(io.includes('mutationObserver.disconnect') && !io.includes('lazyObserver'), 'initObserver touches ONLY mutationObserver');
    const noComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/\blet observer\b|[^a-zA-Z.]observer\.(observe|disconnect|unobserve)/.test(noComments), 'no bare shared observer usage remains (comments excluded)');
    const rb = extract('renderBatch');
    assert(rb.includes('lazyObserver.observe(sentinel)'), 'sentinels observed by lazyObserver');
}

console.log('[7] Reset wiring for scroll-once flag');
{
    const resets = (src.match(/[^t] activeScrolledThisOpen = false/g) || []).length; // excludes 'let activeScrolledThisOpen'
    assert(resets === 5, `flag reset in exactly 5 places, got ${resets}: CHAT_CHANGED, panel open click, char switch, failed-scroll release, popup-visible transition`);
    assert(extract('createFolderDOM').includes('tmc_has_active'), 'folder dot wired');
}


console.log('[8] buildActivityData: branch parentage extraction + character filtering');
{
    const build = new Function(extract('buildActivityData') + '\nreturn buildActivityData;')();
    const items = [
        { file_id: 'Branch #1 - Old', avatar: 'A.png', chat_metadata: { main_chat: 'Old' } },
        { file_id: 'Fresh', avatar: 'A.png' },
        { file_id: 'OtherBranch', avatar: 'B.png', chat_metadata: { main_chat: 'Elsewhere' } },
        { file_id: 'GB', group: 1720000000, chat_metadata: { main_chat: 'GroupParent' } },
        { file_id: 'Old', avatar: 'A.png', chat_metadata: {} },
        { file_id: 'RootStray', chat_metadata: { main_chat: 'X' } },
        null,
        { file_id: 42, avatar: 'A.png' },
    ];
    const a = build(items, 'A.png');
    assert(JSON.stringify(a.branchOf) === JSON.stringify({ 'Branch #1 - Old': 'Old' }),
        'only current character branches captured: ' + JSON.stringify(a.branchOf));
    assert(!('rank' in a), 'rank machinery gone from builder');
    const g = build(items, 1720000000);
    assert(g.branchOf['GB'] === 'GroupParent', 'numeric group id matches via String coercion');
    assert(JSON.stringify(build(undefined, 'A.png')) === JSON.stringify({ branchOf: {} }), 'non-array input safe');
}

console.log('[9] sortChats: precomputed activity field — THE branch scenario');
{
    const mkSort = new Function('sortOrder', extract('sortChats') + '\nreturn sortChats;');
    const mk = (name, date, activity) => ({ fileName: name + '.jsonl', activity, metadata: { name: name.toLowerCase(), date, msgCount: 0, size: 0 } });
    const chats = [
        mk('Ancient', 100, 100),
        mk('Fresh', 3000, 3000),
        mk('Branch #1 - Old', 990, 5000), // stamped: opened just now
        mk('Old', 1000, 1000),
    ];
    let out = mkSort('activity-desc')([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Branch #1 - Old.jsonl', 'Fresh.jsonl', 'Old.jsonl', 'Ancient.jsonl']),
        'stamped branch with OLD last-msg date sorts FIRST: ' + JSON.stringify(out));
    // unstamped library: activity collapses to last-msg time -> branch sinks (pre-fix behavior)
    const cold = chats.map(c => ({ ...c, activity: c.metadata.date }));
    out = mkSort('activity-desc')(cold).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Fresh.jsonl', 'Old.jsonl', 'Branch #1 - Old.jsonl', 'Ancient.jsonl']),
        'unstamped library degrades to last-message desc');
    // floor semantics
    const floor = chats.map(c => ({ ...c, activity: c.fileName.startsWith('Old') ? 2000 : c.metadata.date }));
    out = mkSort('activity-desc')(floor).map(c => c.fileName);
    assert(out[0] === 'Fresh.jsonl' && out[1] === 'Old.jsonl', 'stamp is a floor, not a tier');
    out = mkSort('name-asc')([...chats]).map(c => c.fileName);
    assert(out[0] === 'Ancient.jsonl', 'regression: name-asc unaffected');
}

console.log('[10] getBranchParent: extension stripping and miss behavior');
{
    const getBP = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;')(
        { charKey: 'A.png', fetchedAt: 0, rank: {}, branchOf: { 'X': 'Parent Chat' } });
    assert(getBP('X.jsonl') === 'Parent Chat', 'strips .jsonl before lookup');
    assert(getBP('X') === 'Parent Chat', 'bare name works');
    assert(getBP('Y.jsonl') === null, 'miss returns null');
    assert(getBP(null) === null, 'null-safe');
}

console.log('[11] v0.8.0 wiring: static structure of the real file');
{
    const rad = extract('refreshActivityData');
    const radCode = rad.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!radCode.includes('pinned'), 'refresh omits pinned param in code (would corrupt mtime rank)');
    assert(rad.includes('metadata: true') && rad.includes('/api/chats/recent'), 'requests /recent with metadata:true');
    assert(extract('performSync').includes('refreshActivityData()'), 'performSync kicks TTL-gated refresh');
    const srcNoComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!srcNoComments.includes('refreshActivityData(true)'), 'no force-refresh remains in code (v0.8.1: was firing full-library scan per chat open)');
    assert(src.includes('"activity-desc">Active (Recent)') || src.includes("value=\"activity-desc\">Active (Recent)"), 'dropdown has Active option');
    assert(src.includes("sortOrder: 'activity-desc'"), 'defaultSettings carries persisted default');
    assert(src.includes('getSettings().sortOrder = sortOrder'), 'onchange persists selection');
    assert(extract('createProxyBlock').includes('getBranchParent'), 'branch chip wired into proxy block');
}


const stripComments = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

console.log('[12] v0.8.1 perf wiring: fetch gated behind visible popup, observer scoped');
{
    const ps = stripComments(extract('performSync'));
    const gateIdx = ps.indexOf('if (!popup) return;');
    const fetchIdx = ps.indexOf('refreshActivityData()');
    assert(gateIdx > -1 && fetchIdx > gateIdx, 'refreshActivityData sits AFTER the popup-visible gate');
    const initFn = stripComments(extract('init'));
    assert(initFn.includes('activityData.fetchedAt = 0'), 'CHAT_CHANGED invalidates activity cache');
    assert(!initFn.includes('refreshActivityData'), 'CHAT_CHANGED never fetches directly');
    const io = stripComments(extract('initObserver'));
    assert(io.includes('getPopupNodes()') && io.includes('mutationObserver.observe(node'), 'observer attaches to popup nodes');
    assert(io.includes('document.body'), 'body observation kept only as fallback branch');
    assert(initFn.includes('syncPanelVisibility()') && initFn.includes('if (!userOpenedPanel) return;'), 'heartbeat reconciles visibility then early-outs when closed');
}

console.log('[13] syncPanelVisibility: open/close transitions and bulk-bar teardown');
{
    const mk = new Function('getPopupNodes', 'getComputedStyle', 'scheduleSync', 'clearSelection', 'state',
        'let userOpenedPanel = state.open; let activeScrolledThisOpen = true; let bulkMode = state.bulk; let selectedChats = state.sel; let cardsMode = true; let renderedCounts = {};\n'
        + extract('syncPanelVisibility')
        + '\nreturn { run: syncPanelVisibility, state: () => ({ userOpenedPanel, activeScrolledThisOpen }) };');
    let synced = 0, cleared = 0;
    // hidden -> visible
    let h = mk(() => [{}], () => ({ display: 'flex' }), () => synced++, () => cleared++, { open: false, bulk: false, sel: new Set() });
    h.run();
    assert(h.state().userOpenedPanel === true && h.state().activeScrolledThisOpen === false && synced === 1, 'open transition: flag on, scroll reset, sync scheduled');
    // visible -> hidden with live bulk selection
    h = mk(() => [{}], () => ({ display: 'none' }), () => synced++, () => cleared++, { open: true, bulk: true, sel: new Set(['a']) });
    h.run();
    assert(h.state().userOpenedPanel === false && cleared === 1, 'close transition: flag off, bulk selection torn down');
}

console.log('[14] Content cache LRU: cap, eviction order, touch-refresh');
{
    const capMatch = src.match(/const CONTENT_CACHE_MAX = (\d+);/);
    assert(!!capMatch, 'cap constant present');
    const cap = parseInt(capMatch[1], 10);
    const mk = new Function('CONTENT_CACHE_MAX',
        // v0.16.0: touchContentCache also evicts the per-key error stamps —
        // the sandbox must declare chatContentErrAt or the guard throws.
        'let chatContentCache = {}; let contentCacheOrder = []; let chatContentErrAt = {};\n'
        + extract('touchContentCache')
        + '\nreturn { touch: touchContentCache, set: (k) => { chatContentCache[k] = [k]; chatContentErrAt[k] = 1; touchContentCache(k); }, cache: () => chatContentCache, order: () => contentCacheOrder, err: () => chatContentErrAt };');
    const c = mk(cap);
    for (let i = 0; i < cap + 6; i++) c.set('A.png::chat' + i);
    assert(Object.keys(c.cache()).length === cap, `cache bounded at ${cap} after ${cap + 6} inserts`);
    assert(!c.cache()['A.png::chat0'] && !!c.cache()['A.png::chat' + (cap + 5)], 'oldest evicted, newest kept');
    // v0.16.0: an evicted entry's error stamp goes with it
    assert(!c.err()['A.png::chat0'], 'error stamp evicted with its cache entry');
    // touch-refresh: oldest surviving key touched, then one more insert evicts the SECOND-oldest instead
    const survivors = c.order().slice();
    c.touch(survivors[0]);
    c.set('A.png::fresh');
    assert(!!c.cache()[survivors[0]] && !c.cache()[survivors[1]], 'touched entry survives; untouched next-oldest evicted');
}

console.log('[15] Pin scoping: per-character isolation with legacy migration');
{
    const shared = { pinned: { 'New Chat.jsonl': true } }; // legacy global pin
    let charKey = 'A.png';
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'saveSettings', 'scheduleSync',
        extract('normalizeChatId') + '\n' + extract('pinKey') + '\n' + extract('isPinnedFile') + '\n' + extract('togglePin')
        + '\nreturn { pinKey, isPinnedFile, togglePin };');
    const api15 = mk(() => shared, () => charKey, () => {}, () => {});
    assert(api15.isPinnedFile('New Chat.jsonl') === true, 'legacy bare-key pin honored on read');
    api15.togglePin('New Chat.jsonl'); // unpin: migrates legacy away
    assert(!shared.pinned['New Chat.jsonl'] && !shared.pinned['A.png::New Chat'] && !shared.pinned['New Chat'], 'toggle migrates legacy key away');
    api15.togglePin('New Chat.jsonl'); // pin again -> scoped
    assert(shared.pinned['A.png::New Chat'] === true, 'repin writes normalized character-scoped key');
    charKey = 'B.png';
    assert(api15.isPinnedFile('New Chat.jsonl') === false, 'same filename NOT pinned on another character');
}

console.log('[16] Group preview fetches THIS entry, not the open chat');
{
    const fcm = stripComments(extract('fetchChatMessages'));
    assert(/isGroup\s*\n?\s*\?\s*\{\s*id:\s*fileName\.replace/.test(fcm), 'group body id derived from fileName');
    assert(!/id:\s*context\.groupId/.test(fcm), 'old wrong-file body gone');
    assert(fcm.includes('contentCacheKey(fileName)'), 'cache reads/writes use character-scoped key');
}

console.log('[17] escAttr: selector-safe filenames');
{
    const esc = new Function(extract('escAttr') + '\nreturn escAttr;')();
    assert(esc('a"b\\c') === 'a\\"b\\\\c', 'quotes and backslashes escaped');
    assert(esc('plain name.jsonl') === 'plain name.jsonl', 'plain names untouched');
    assert(stripComments(extract('findNativeBlock')).includes('escAttr(fileName)'), 'native block lookup routed through escAttr');
}

console.log('[18] Bulk delete: group branch wired through ST group-chats module');
{
    const ub = stripComments(extract('updateBulkBar'));
    assert(ub.includes("import('/scripts/group-chats.js')") && ub.includes('deleteGroupChatByName(groupId'), 'group path uses deleteGroupChatByName');
    assert(ub.includes('!groupId && (characterId === undefined'), 'character-missing error only fires OUTSIDE groups');
}

console.log('[19] refreshActivityData: stale branch map dropped on switch; small fetch window');
{
    let fetchCalls = 0; let lastBody = null;
    const pendingFetch = (url, opts) => { fetchCalls++; lastBody = opts.body; return new Promise(() => {}); };
    const ttl = parseInt(src.match(/const ACTIVITY_TTL_MS = (\d+);/)[1], 10);
    const bmax = parseInt(src.match(/const BRANCH_FETCH_MAX = (\d+);/)[1], 10);
    assert(bmax <= 100, `branch fetch window small (${bmax}) — endpoint only line-streams top-N, so cost stays bounded`);
    const mk = new Function('getCurrentCharacterId', 'buildActivityData', 'scheduleSync', 'fetch', 'SillyTavern', 'ACTIVITY_TTL_MS', 'BRANCH_FETCH_MAX', 'initial', 'console',
        'let activityData = initial;\n' + 'async ' + extract('refreshActivityData')
        + '\nreturn { run: refreshActivityData, get: () => activityData };');
    const a = mk(() => 'B.png', () => ({ branchOf: {} }), () => {}, pendingFetch,
        { getContext: () => ({ getRequestHeaders: () => ({}) }) }, ttl, bmax,
        { charKey: 'A.png', fetchedAt: Date.now(), branchOf: { 'Old': 'P' } }, console);
    a.run(); // char switched A -> B; fetch left pending on purpose
    assert(a.get().charKey === 'B.png' && Object.keys(a.get().branchOf).length === 0, 'previous character branch map dropped before fetch resolves');
    assert(fetchCalls === 1 && JSON.parse(lastBody).max === bmax && JSON.parse(lastBody).metadata === true, 'one fetch, bounded max, metadata on');
    a.run(); // same char, within TTL, not forced
    assert(fetchCalls === 1, 'TTL gate suppresses duplicate fetch');
}

console.log('[20] Search render fan-out capped');
{
    assert(/searchTerm\s*\n?\s*\?\s*Math\.min\(/.test(extract('performSync')), 'initial search render capped via Math.min (sentinel lazy-loads rest)');
}


console.log('[21] Activity stamping: write, scope, prune');
{
    const shared2 = { lastActive: {} };
    let saves = 0; let charKey2 = 'A.png'; let activeChat = 'My Branch';
    const capHard = parseInt(src.match(/const LAST_ACTIVE_HARD_CAP = (\d+);/)[1], 10);
    const capKeep = parseInt(src.match(/const LAST_ACTIVE_KEEP = (\d+);/)[1], 10);
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'getActiveChatName', 'saveSettings', 'LAST_ACTIVE_HARD_CAP', 'LAST_ACTIVE_KEEP',
        extract('lastActiveKey') + '\n' + extract('stampActivity') + '\n' + extract('getLastActive') + '\n' + extract('pruneLastActive')
        + '\nreturn { stamp: stampActivity, get: getLastActive, prune: pruneLastActive };');
    const api21 = mk(() => shared2, () => charKey2, () => activeChat, () => saves++, capHard, capKeep);
    api21.stamp();
    assert(api21.get('My Branch.jsonl') > 0 && saves === 1, 'stamp written under scoped key, settings saved');
    charKey2 = 'B.png';
    assert(api21.get('My Branch.jsonl') === 0, 'stamp invisible from another character');
    charKey2 = 'A.png'; activeChat = null;
    api21.stamp();
    assert(saves === 1, 'no active chat -> no write, no save');
    // prune: overfill past hard cap, oldest dropped, newest kept
    const m = {};
    for (let i = 1; i <= capHard + 1; i++) m['A.png::c' + i] = i;
    api21.prune(m);
    assert(Object.keys(m).length === capKeep, `pruned to ${capKeep}`);
    assert(!m['A.png::c1'] && !!m['A.png::c' + (capHard + 1)], 'oldest evicted, newest kept');
}

console.log('[22] getBranchParent: metadata first, filename-pattern fallback');
{
    const mk = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;');
    const getBP = mk({ branchOf: { 'Meta Chat': 'Real Parent', 'Named - Branch #9': 'Metadata Wins' } });
    assert(getBP('Meta Chat.jsonl') === 'Real Parent', 'metadata hit');
    assert(getBP('Named - Branch #9.jsonl') === 'Metadata Wins', 'metadata takes precedence over pattern');
    assert(getBP('Epic Story - Branch #3.jsonl') === 'Epic Story', 'modern naming fallback');
    assert(getBP('Branch #2 - Old Tale') === 'Old Tale', 'legacy naming fallback');
    assert(getBP('Just A Chat.jsonl') === null, 'plain chats untouched');
}


console.log('[23] resolveFamilyRoot: transitive climb, cycle guard, extension handling');
{
    const chains = { 'C': 'B', 'B': 'A' };
    const mk = new Function('getBranchParent', extract('resolveFamilyRoot') + '\nreturn resolveFamilyRoot;');
    const resolve = mk((id) => chains[String(id).replace(/\.jsonl$/i, '')] || null);
    assert(resolve('C.jsonl') === 'A', 'branch-of-a-branch climbs to root (C -> B -> A)');
    assert(resolve('A') === 'A', 'root resolves to itself');
    const cyc = mk((id) => ({ 'A': 'B', 'B': 'A' }[id] || null));
    const r = cyc('A');
    assert(r === 'A' || r === 'B', 'parentage cycle terminates deterministically without throwing');
}

console.log('[24] familyClusters: lineage sections, orphan branches, singles');
{
    const clusters = new Function(extract('familyClusters') + '\nreturn familyClusters;')();
    const resolver = (id) => {
        const m = id.match(/^(.*) - Branch #\d+$/) || id.match(/^Branch #\d+ - (.*)$/);
        return m ? m[1] : id;
    };
    const out = clusters(['Branch #2 - Saga', 'Solo', 'Saga', 'Lost Tale - Branch #1'], resolver);
    assert(JSON.stringify(out.order) === JSON.stringify(['Saga', 'Lost Tale']),
        'family order follows first appearance (= most recently active member): ' + JSON.stringify(out.order));
    assert(JSON.stringify(out.members['Saga']) === JSON.stringify(['Branch #2 - Saga', 'Saga']),
        'parent and branches share one section, input order preserved');
    assert(JSON.stringify(out.members['Lost Tale']) === JSON.stringify(['Lost Tale - Branch #1']),
        'orphan branch (parent deleted) still forms a family under the lineage name');
    assert(JSON.stringify(out.singles) === JSON.stringify(['Solo']), 'non-branch chats without branches stay single');
    assert(JSON.stringify(clusters([], resolver)) === JSON.stringify({ order: [], members: {}, singles: [] }), 'empty input safe');
}

console.log('[25] Family view wiring: static structure of the real file');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('familyClusters(') && ps.includes("'family::' + root"), 'performSync builds family sections from sorted order');
    assert(ps.includes("createUncategorizedDOM('Other chats')"), 'non-family chats routed to Other chats in family mode');
    assert(ps.includes('familyFidByChat[chatId]'), 'distribution loop routes through the family map');
    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes("!isFamily") && rb.includes("|| isFamily)"), 'families exempt from 3-item truncation, included in sentinel lazy-load');
    assert(rb.includes('escAttr(folderId)'), 'section lookup selector escaped (family ids contain arbitrary chat names)');
    const ib = stripComments(extract('injectAddButton'));
    assert(ib.includes('s.familyView = !s.familyView') && ib.includes('saveSettings()'), 'toggle persists');
    assert(src.includes('familyView: false') && src.includes('familyCollapsed: {}'), 'settings schema carries family keys');
    assert(stripComments(extract('createFamilyDOM')).includes('familyCollapseKey(root)'), 'collapse state character-scoped');
}


console.log('[26] Chat id normalization: folders survive with/without .jsonl eras');
{
    const shared26 = { folders: { f1: { name: 'F', chats: ['Old Tale.jsonl'] } }, characterFolders: { 'A.png': ['f1'] } };
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'saveSettings', 'scheduleSync',
        // v0.14.0: moveChat delegates to moveChats — a sandboxed function's
        // callees must be in the extraction list or the ReferenceError
        // surfaces as an unrelated failure (see AGENTS.md).
        extract('normalizeChatId') + '\n' + extract('moveChat') + '\n' + extract('moveChats')
        + '\n' + extract('getFolderForChat')
        + '\nreturn { moveChat, getFolderForChat };');
    const api26 = mk(() => shared26, () => 'A.png', () => {}, () => {});
    assert(api26.getFolderForChat('Old Tale') === 'f1', 'legacy .jsonl-stored id matches current extensionless block');
    assert(api26.getFolderForChat('Old Tale.jsonl') === 'f1', 'and matches with extension too');
    api26.moveChat('New Story.jsonl', 'f1');
    assert(shared26.folders.f1.chats.includes('New Story') && !shared26.folders.f1.chats.includes('New Story.jsonl'),
        'moveChat stores normalized ids');
    api26.moveChat('Old Tale', 'uncategorized');
    assert(!shared26.folders.f1.chats.some(c => c.includes('Old Tale')), 'move-out strips legacy variant as well');
    const initSrc = stripComments(extract('init'));
    assert(initSrc.includes('normalizeChatId') && initSrc.includes('new Set'), 'one-time init migration normalizes + dedupes stored folder ids');
}

console.log('[27] Comparator perf: activity precomputed once per item per sync');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('const laMap = getSettings().lastActive || {};'), 'stamp map snapshotted once per sync');
    assert((ps.match(/laPrefix \+ fileName\.replace/g) || []).length === 2, 'activity computed on both cache-hit and fresh paths');
    const sc = stripComments(extract('sortChats'));
    assert(sc.includes('a.activity') && !sc.includes('getLastActive('), 'comparator reads precomputed field, never calls getSettings');
}

console.log('[28] Click-time native re-resolution');
{
    const cpb = stripComments(extract('createProxyBlock'));
    assert((cpb.match(/findNativeBlock\(chatData\.fileName\)/g) || []).length >= 2, 'both button-forward and load-chat re-resolve at click time');
    assert(cpb.includes('liveNative.querySelector'), 'forwarded buttons search the LIVE native block');
}

console.log('[29] Scroll + rendered-depth persistence across re-syncs');
{
    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes('renderedCounts[folderId] = Math.max'), 'renderBatch records section depth');
    const ps = stripComments(extract('performSync'));
    // v0.14.0: this used to assert `body.scrollTop`, where `body` resolved to
    // #shadow_select_chat_popup — an element with no overflow, whose scrollTop
    // is permanently 0. The assertion passed while the feature did nothing.
    // It is now pinned to the resolved scroll container.
    assert(ps.includes('scroller.scrollTop || 0') && ps.includes('scroller.scrollTop = lastScrollTop'),
        'scroll captured and restored around rebuild, on the element that actually scrolls');
    assert(!ps.includes('body.scrollTop'), 'no scroll access on the non-scrolling popup element');
    assert(ps.includes('renderedCounts = {};') && ps.includes('lastSearchTermSeen'), 'depths reset when the search term changes');
    assert(ps.includes('Math.min(renderedCounts[fid] || 0, sectionLen)'), 'initial batch restores remembered depth (clamped)');
    assert(stripComments(extract('syncPanelVisibility')).includes('renderedCounts = {}'), 'depths reset on popup close');
}

console.log('[30] Enrichment size guard');
{
    const cpb = stripComments(extract('createProxyBlock'));
    assert(cpb.includes('ENRICH_MAX_BYTES') && /<= ENRICH_MAX_BYTES\)\s*{\s*enrichPreviewWithContext/.test(cpb),
        'content fetch skipped for oversized chats; native preview retained');
}

console.log('[31] Proxy delete click routes to delete, not chat-load');
{
    const cpb = extract('createProxyBlock');
    assert(cpb.includes('.PastChat_cross, .fa-skull') || (cpb.includes('.PastChat_cross') && cpb.includes('.fa-skull')),
        'click-gate lists the native delete button classes');
    assert(cpb.includes("'.PastChat_cross, .mes_delete, .fa-trash, .fa-skull"), 'forward mapping includes PastChat_cross');
}

console.log('[32] Title resolver + jump-to-open');
{
    const el = document.createElement('div');
    el.innerHTML = '<div><small class="select_chat_block_filename">My Chat</small></div><div class="select_chat_block_mes">preview</div>';
    const getTitle = new Function('el', extract('getTitleEl').replace(/^function getTitleEl\(el\)/, 'function getTitleEl(el)') + '\nreturn getTitleEl(el);');
    const t = getTitle(el);
    assert(t && t.textContent === 'My Chat', 'current ST title class resolved (highlighting/chips land in the title row again)');
    const ib = stripComments(extract('injectAddButton'));
    assert(ib.includes('tmc_jump_btn') && ib.includes('jumpToOpenChat(popup)'), 'jump-to-open button wired');
    assert(!src.includes('createRecentDOM'), 'dead createRecentDOM removed');

    // v0.14.0: the button used to give up with "not in the current view"
    // whenever the open chat was not currently RENDERED — the common case,
    // since main view truncates every manual folder to 3 rows. It now
    // navigates to where the chat lives and retries.
    const jo = stripComments(extract('jumpToOpenChat'));
    assert(jo.includes('scrollIntoView'), 'still scrolls when the row is on screen');
    assert(jo.includes('getFolderForChat(active)') && jo.includes("currentView = 'folder'"),
        'drills into the folder holding the open chat');
    assert(jo.includes('familyCollapseKey(root)') && jo.includes('delete settings.familyCollapsed[key]'),
        'expands the family section holding the open chat');
    assert(jo.includes('cardsMode = false'), 'steps out of the cross-card browser first');
    assert(jo.includes('performSync()') && (jo.match(/flash\(\)/g) || []).length >= 3,
        'renders, then retries the scroll');
    assert(!jo.includes('Open chat is not in the current view'),
        'the old dead-end message is gone');
}


console.log('[33] pickFreeName: never overwrite on the target card');
{
    const pick = new Function(extract('pickFreeName') + '\nreturn pickFreeName;')();
    const taken = new Set(['Saga', 'Saga #2']);
    assert(pick('Fresh', taken) === 'Fresh', 'free name passes through');
    assert(pick('Saga', taken) === 'Saga #3', 'collision walks past existing suffixes');
}

console.log('[34] adaptChatForTarget: header + source-named AI messages only');
{
    // v0.14.0: adaptChatForTarget now mints a fresh integrity token, so its
    // callee must be in the extraction list (see AGENTS.md).
    const adapt = new Function('crypto', extract('freshIntegrity') + '\n' + extract('adaptChatForTarget')
        + '\nreturn adaptChatForTarget;')({ randomUUID: () => 'NEW-UUID' });
    const input = [
        { user_name: 'LO', character_name: 'Seika', chat_metadata: { main_chat: 'X' } },
        { name: 'Seika', is_user: false, mes: 'hello' },
        { name: 'LO', is_user: true, mes: 'hi' },
        { name: 'Rival NPC', is_user: false, mes: 'hmph' },
    ];
    const out = adapt(input, 'Seika', 'Seika V2');
    assert(out[0].character_name === 'Seika V2' && out[0].chat_metadata.main_chat === 'X', 'header rewritten, metadata preserved');
    assert(out[1].name === 'Seika V2', 'source-named AI message renamed');
    assert(out[2].name === 'LO' && out[3].name === 'Rival NPC', 'user + other NPCs untouched');
    assert(input[0].character_name === 'Seika' && input[1].name === 'Seika', 'input array not mutated');
}

console.log('[35] buildCardsOverview: per-card sections, name resolution, ordering');
{
    const build = new Function(extract('buildCardsOverview') + '\nreturn buildCardsOverview;')();
    const items = [
        { file_id: 'B chat', avatar: 'Beta.png', mes: 'p', chat_items: 3 },
        { file_id: 'A chat 1', avatar: 'Alpha.png', mes: 'q', chat_items: 5 },
        { file_id: 'G chat', group: 777, mes: 'g', chat_items: 2 },
        { file_id: 'A chat 2', avatar: 'Alpha.png', mes: 'r', chat_items: 1 },
        { file_id: 'stray' },
        null,
    ];
    const chars = [{ avatar: 'Alpha.png', name: 'Alpha Prime' }]; // Beta unresolvable
    const groups = [{ id: 777, name: 'The Party' }];
    const out = build(items, chars, groups);
    assert(out.map(e => e.name).join('|') === 'Beta|Alpha Prime|The Party', 'first-appearance order (mtime), names resolved, avatar fallback strips .png: ' + out.map(e => e.name).join('|'));
    assert(out[1].chats.map(c => c.id).join('|') === 'A chat 1|A chat 2', 'per-card chat order preserved');
    assert(out.every(e => e.chats.length > 0) && out.length === 3, 'root strays and malformed items skipped');
}

console.log('[36] moveChatToCharacter: loss-safe pipeline ordering');
{
    const calls = [];
    // v0.14.0: /get now serves TWO purposes — reading the source chat and
    // probing whether the destination name is already taken. The mock
    // distinguishes them by avatar_url, exactly as the server does.
    const mkFetch = (opts) => async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        const isProbe = url.includes('/get') && body.avatar_url === 'Dst.png';
        const kind = isProbe ? 'probe'
            : url.includes('/get') ? 'get'
                : url.includes('/save') ? 'save'
                    : url.includes('/delete') ? 'delete' : url;
        calls.push(kind);
        if (kind === 'probe') return { ok: true, json: async () => (opts.destTaken ? [{ mes: 'someone else' }] : []) };
        if (kind === 'get') return { ok: true, json: async () => (opts.emptyGet ? [] : [{ user_name: 'u', character_name: 'Src' }, { name: 'Src', is_user: false, mes: 'm' }]) };
        if (kind === 'save') return { ok: !opts.saveFail, json: async () => ({ ok: !opts.saveFail }) };
        if (kind === 'delete') return { ok: !opts.deleteFail };
        return { ok: false };
    };
    const deps = 'let settingsObj = { folders: {}, characterFolders: {}, pinned: {}, lastActive: {} };';
    const build = (opts) => new Function('fetch', 'SillyTavern', 'toastr', 'console',
        deps
        + '\nconst getSettings = () => settingsObj; const saveSettings = () => {}; const scheduleSync = () => {};'
        + '\nconst findNativeBlock = () => null; const pruneLastActive = () => {};'
        + '\n' + extract('normalizeChatId') + '\n' + extract('stHeaders') + '\n' + extract('freshIntegrity') + '\n' + extract('adaptChatForTarget') + '\n' + extract('pickFreeName')
        + '\n' + extract('stripDeletedFromFolders')
        + '\nasync ' + extract('targetChatExists')
        + '\nasync ' + extract('moveChatToCharacter')
        + '\nreturn { move: moveChatToCharacter, settings: () => settingsObj };')(
        mkFetch(opts), { getContext: () => ({ getRequestHeaders: () => ({}) }) }, { }, console);

    // happy path
    let h = build({});
    let r = await h.move('Tale.jsonl', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === true && calls.join('>') === 'get>probe>save>delete',
        'order: read source -> probe destination -> write target -> delete source');
    assert(h.settings().lastActive['Dst.png::Tale'] > 0, 'moved chat stamped on the TARGET card');
    // save failure aborts BEFORE delete
    calls.length = 0;
    r = await build({ saveFail: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === false && !calls.includes('delete'), 'write failure -> source untouched, no delete issued');
    // delete failure degrades to duplicate warning, still ok
    calls.length = 0;
    r = await build({ deleteFail: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === true && !!r.warn, 'delete failure -> duplicate + warning, never loss');
    // empty/unreadable source skipped before any write
    calls.length = 0;
    r = await build({ emptyGet: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === false && !calls.includes('save'), 'unreadable source -> no write attempted');

    // v0.14.0: an occupied destination must NEVER be written over. The
    // listing-derived takenSet cannot see this (the server sanitizes the name
    // after we choose it), so the probe is the guard that matters.
    calls.length = 0;
    r = await build({ destTaken: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === false, 'permanently-occupied destination -> move refused');
    assert(!calls.includes('save') && !calls.includes('delete'),
        'nothing written and nothing deleted: the source survives intact');
    assert(calls.filter(c => c === 'probe').length > 1, 'alternative names were tried before giving up');
}

console.log('[37] v0.12.0 wiring');
{
    const bm = stripComments(extract('bulkMoveToCharacter'));
    assert(bm.includes('isActiveChatFile(fileName)'), 'open chat skipped (autosave would recreate the source file)');
    assert(bm.includes('context.groupId') && bm.includes('supported'), 'group chats guarded with a clear message');
    assert(stripComments(extract('updateBulkBar')).includes('tmc_bulk_movechar'), 'bulk bar carries To card');
    assert(stripComments(extract('showContextMenu')).includes("'movechar'") || stripComments(extract('showContextMenu')).includes('movechar'), 'single-chat menu carries Move to card');
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('if (cardsMode)') && ps.includes('renderCardsTree(proxyRoot)'), 'cards mode replaces the tree');
    assert(stripComments(extract('syncPanelVisibility')).includes('cardsMode = false'), 'cards mode resets on popup close');
    const jc = stripComments(extract('jumpToCard'));
    assert(jc.includes('selectCharacterById(idx)') && jc.includes('openCharacterChat(chatId)'), 'solo jump: select card then open chat');
    assert(jc.includes('openGroupById') && jc.includes('openGroupChat'), 'group jump wired');
    const cb = parseInt(src.match(/const CARDS_FETCH_MAX = (\d+);/)[1], 10);
    assert(cb <= 500, 'cards fetch bounded (' + cb + ')');
}


console.log('[38] Move-to section: contextual items, no more silent no-op entry');
{
    const build = new Function('escapeHtml', extract('buildMoveSectionHtml') + '\nreturn buildMoveSectionHtml;')((s) => s);
    // his exact situation: zero folders, chat uncategorized
    let html = build([], 'uncategorized', false);
    assert(!html.includes('Your chats') && !html.includes('Remove from folder'), 'no folders -> no dead entries');
    assert(html.includes('newfolder-move'), 'New folder… offered instead');
    // in a folder
    html = build([{ fid: 'f1', name: 'Arcs' }, { fid: 'f2', name: 'Side' }], 'f1', false);
    assert(html.includes('Arcs ✓') && html.includes('tmc_ctx_current'), 'current folder marked');
    assert(html.includes('Remove from folder'), 'remove offered when actually in a folder');
    // uncategorized WITH folders existing
    html = build([{ fid: 'f1', name: 'Arcs' }], 'uncategorized', false);
    assert(!html.includes('Remove from folder'), 'no remove when not in a folder');
    // bulk
    html = build([{ fid: 'f1', name: 'Arcs' }], 'uncategorized', true);
    assert(html.includes('Remove from folders') && !html.includes('✓'), 'bulk: plural remove, no current marker');
    // folder names still escaped upstream
    const esc = new Function('escapeHtml', extract('buildMoveSectionHtml') + '\nreturn buildMoveSectionHtml;')((s) => s.replace(/</g, '&lt;'));
    assert(!esc([{ fid: 'f1', name: '<img>' }], 'x', false).includes('<img>'), 'folder names escaped');
}

console.log('[39] formatRelativeTime');
{
    const rel = new Function(extract('formatRelativeTime') + '\nreturn formatRelativeTime;')();
    const now = 1000000000000;
    assert(rel(now - 30 * 1000, now) === 'now', 'sub-minute');
    assert(rel(now - 5 * 60000, now) === '5m ago', 'minutes');
    assert(rel(now - 3 * 3600000, now) === '3h ago', 'hours');
    assert(rel(now - 49 * 3600000, now) === '2d ago', 'days');
}

console.log('[40] Feedback wiring');
{
    const cm = stripComments(extract('showContextMenu'));
    assert(cm.includes('buildMoveSectionHtml(folderList, currentFid, isBulk)'), 'menu uses the contextual builder');
    assert(cm.includes('Already in') && cm.includes('Removed from') && cm.includes('Moved to'), 'every outcome toasts — including the former silent no-op');
    assert(cm.includes('newfolder-move') && cm.includes('createFolder(n)'), 'new-folder-and-move path wired');
    assert(cm.includes('visible when Families is off'), 'family-mode moves explain where the chat went');
    const cf = stripComments(extract('createFolder'));
    assert(cf.includes('return folderId;') && cf.includes('return null;'), 'createFolder returns fid / null');
    const cpb = stripComments(extract('createProxyBlock'));
    assert(cpb.includes('tmc_activity_hint') && cpb.includes('shownDate + 60000'), 'stamp-driven ordering surfaced as a chip when it outranks the visible date');
}

console.log('[41] partitionPinned: pins float without inverting their order');
{
    const fn = new Function(extract('partitionPinned') + '\nreturn partitionPinned;')();
    const list = ['p1', 'a', 'p2', 'b', 'p3'];
    const isPin = x => x.startsWith('p');
    assert(fn(list, isPin).join('|') === 'p1|p2|p3|a|b', 'pinned cluster keeps global sort order, rest follows');
    // negative proof: the OLD unshift-per-pin flow produced the reverse
    const old = []; for (const x of list) { if (isPin(x)) old.unshift(x); else old.push(x); }
    assert(old.join('|') === 'p3|p2|p1|a|b', 'sanity: old flow really did invert pinned order (the bug)');
    assert(fn([], isPin).length === 0 && fn(null, isPin).length === 0, 'empty / null inputs safe');
}

console.log('[42] reuseCachedNative: survives ST rebuilding blocks per search keystroke');
{
    const fn = new Function(extract('reuseCachedNative') + '\nreturn reuseCachedNative;')();
    const mk = (text) => { const d = document.createElement('div'); d.textContent = text; return d; };
    const b1 = mk('Tale  Jul 29, 2026 4:00 PM (2KB, 12 msgs) last line');
    const cached = { element: b1, signature: b1.textContent, html: '<i>parsed</i>' };
    assert(fn(cached, b1) === true, 'identity hit still reuses');
    const rebuilt = mk('Tale  Jul 29, 2026 4:00 PM (2KB, 12 msgs) last line');
    assert(cached.element !== rebuilt, 'sanity: rebuilt block is a different element (identity-only cache missed here)');
    assert(fn(cached, rebuilt) === true, 'rebuilt-but-identical block reuses the parse (THE fix)');
    assert(cached.element === rebuilt, 'cache adopts the new element');
    const changed = mk('Tale  Jul 29, 2026 4:05 PM (3KB, 13 msgs) newer line');
    assert(fn(cached, changed) === false, 'real content change invalidates (new message -> re-parse)');
    assert(fn(undefined, b1) === false, 'no cache entry -> parse');
    assert(fn({ element: mk('x') }, mk('')) === false, 'legacy entry without signature + different element -> re-parse, never false-reuse');
}

console.log('[43] migrateChatRename: rename keeps folder, pin, stamp, collapse state');
{
    const fn = new Function(extract('normalizeChatId') + '\n' + extract('migrateChatRename') + '\nreturn migrateChatRename;')();
    const mk = () => ({
        folders: { f1: { chats: ['Old Tale'] }, f2: { chats: ['Other'] }, fx: { chats: ['Old Tale'] } },
        characterFolders: { 'A.png': ['f1', 'f2'], 'B.png': ['fx'] },
        pinned: { 'A.png::Old Tale': true },
        lastActive: { 'A.png::Old Tale': 1000 },
        familyCollapsed: { 'A.png::Old Tale': true },
    });
    let s = mk();
    assert(fn(s, 'A.png', 'Old Tale', 'New Tale') === true, 'reports change');
    assert(s.folders.f1.chats.join('|') === 'New Tale', 'folder membership follows the rename');
    assert(s.folders.fx.chats.join('|') === 'Old Tale', 'other character\'s same-named chat untouched');
    assert(s.pinned['A.png::New Tale'] === true && !('A.png::Old Tale' in s.pinned), 'pin follows');
    assert(s.lastActive['A.png::New Tale'] === 1000 && !('A.png::Old Tale' in s.lastActive), 'stamp follows');
    assert(s.familyCollapsed['A.png::New Tale'] === true && !('A.png::Old Tale' in s.familyCollapsed), 'family collapse state follows');
    // stamp max-merge: never clobber a NEWER stamp already under the new name
    s = mk(); s.lastActive['A.png::New Tale'] = 5000;
    fn(s, 'A.png', 'Old Tale', 'New Tale');
    assert(s.lastActive['A.png::New Tale'] === 5000, 'newer stamp under the new name wins (max-merge)');
    // ghost dedupe: renaming onto a name with a stale ghost entry
    s = mk(); s.folders.f1.chats = ['Old Tale', 'New Tale'];
    fn(s, 'A.png', 'Old Tale', 'New Tale');
    assert(s.folders.f1.chats.join('|') === 'New Tale', 'ghost entry under the new name deduped');
    assert(fn(mk(), 'A.png', 'Same', 'Same') === false, 'same-name rename is a no-op');
    assert(fn(mk(), 'A.png', 'Never Existed', 'X') === false, 'unknown chat is a clean no-op');
}

console.log('[44] stripDeletedFromFolders: normalized cleanup incl. pin + stamp');
{
    const fn = new Function(extract('normalizeChatId') + '\n' + extract('stripDeletedFromFolders') + '\nreturn stripDeletedFromFolders;')();
    const s = {
        folders: { f1: { chats: ['Tale', 'Keep'] } },
        characterFolders: { 'A.png': ['f1'] },
        pinned: { 'A.png::Tale': true, 'A.png::Keep': true },
        lastActive: { 'A.png::Tale': 42, 'A.png::Keep': 43 },
    };
    // deleted names arrive WITH .jsonl (block spelling on some builds)
    assert(fn(s, 'A.png', ['Tale.jsonl']) === true, 'reports change');
    assert(s.folders.f1.chats.join('|') === 'Keep', 'normalized match removed the assignment');
    assert(!('A.png::Tale' in s.pinned) && s.pinned['A.png::Keep'] === true, 'pin dropped for deleted, kept for others');
    assert(!('A.png::Tale' in s.lastActive) && s.lastActive['A.png::Keep'] === 43, 'stamp dropped for deleted, kept for others');
    // negative proof: the OLD raw-includes comparison matched nothing here
    assert(['Tale'].filter(f => !['Tale.jsonl'].includes(f)).length === 1, 'sanity: old raw includes() left the ghost behind (the bug)');
    assert(fn(s, null, ['x']) === false && fn(s, 'A.png', []) === false, 'no character / empty list are clean no-ops');
}

console.log('[45] clampMenuToViewport: menus always land fully on-screen');
{
    const fn = new Function(extract('clampMenuToViewport') + '\nreturn clampMenuToViewport;')();
    const mkMenu = (rect) => ({ getBoundingClientRect: () => rect, style: {} });
    const win = { innerWidth: 390, innerHeight: 800 };
    // kebab tap near the bottom-right of a phone screen
    let m = mkMenu({ left: 300, top: 700, right: 460, bottom: 900, width: 160, height: 200 });
    fn(m, win);
    assert(m.style.left === '222px', 'right overflow clamped inside viewport (390-8-160)');
    assert(m.style.top === '592px', 'bottom overflow clamped inside viewport (800-8-200)');
    assert(m.style.right === 'auto', 'right anchor cleared so left wins');
    // sanity: pre-clamp the menu really did hang off-screen
    assert(900 > win.innerHeight && 460 > win.innerWidth, 'sanity: unclamped rect overflowed both edges (the bug)');
    // a menu already fully visible is not moved
    m = mkMenu({ left: 40, top: 60, right: 200, bottom: 260, width: 160, height: 200 });
    fn(m, win);
    assert(m.style.left === '40px' && m.style.top === '60px', 'already-visible menu stays put');
    // a menu TALLER than the viewport pins to the top pad, not negative
    m = mkMenu({ left: 10, top: 100, right: 170, bottom: 1000, width: 160, height: 900 });
    fn(m, win);
    assert(m.style.top === '8px', 'oversized menu pins to top padding, never negative');
}

console.log('[46] buildFolderList: existence-based, never name-based');
{
    const fn = new Function(extract('buildFolderList') + '\nreturn buildFolderList;')();
    const s = {
        folders: { f1: { name: '?' }, f2: { name: 'Real' } },
        characterFolders: { 'A.png': ['f1', 'f2', 'fDeleted'] },
    };
    const out = fn(s, 'A.png');
    assert(out.length === 2 && out[0].name === '?' && out[1].name === 'Real', 'folder literally named "?" is included (old filter dropped it)');
    assert(!out.some(f => f.fid === 'fDeleted'), 'dangling folder id excluded');
    assert(fn({}, 'A.png').length === 0, 'empty settings safe');
}

console.log('[47] Family dot: lights up when ANY member is the open chat');
{
    const deps = 'const getSettings = () => ({ familyCollapsed: {} });'
        + '\nconst saveSettings = () => {}; const scheduleSync = () => {};'
        + '\nconst familyCollapseKey = (r) => "c::" + r;'
        + '\nconst isActiveChatFile = (f) => String(f).replace(/\\.jsonl$/i, "") === ACTIVE;';
    const build = (active) => new Function('document', 'ACTIVE',
        deps + '\n' + extract('escapeHtml') + '\n' + extract('createFamilyDOM')
        + '\nreturn createFamilyDOM;')(document, active);
    let section = build('Branch 1')('Root Tale', 2, ['Root Tale', 'Branch 1']);
    assert(section.classList.contains('tmc_has_active'), 'open BRANCH lights the family dot (THE fix)');
    section = build('Branch 1')('Root Tale', 2);
    assert(!section.classList.contains('tmc_has_active'), 'sanity: root-only fallback (old behavior) misses the open branch');
    section = build('Root Tale')('Root Tale', 2, ['Root Tale', 'Branch 1']);
    assert(section.classList.contains('tmc_has_active'), 'open root still lights it');
    section = build('Elsewhere')('Root Tale', 2, ['Root Tale', 'Branch 1']);
    assert(!section.classList.contains('tmc_has_active'), 'no member open -> no dot');
}

console.log('[48] v0.13.0 wiring: every fix is actually connected');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('const visibleData = sortedData.filter'), 'visibility decided once, upstream');
    assert(ps.includes('visibleData.map(c => c.fileName'), 'family clustering sees only visible chats');
    assert(ps.includes('visibleData.forEach(chat =>'), 'distribution iterates the visible list');
    assert(!ps.includes('.unshift(chat)'), 'inverting unshift-per-pin is gone');
    assert(ps.includes('partitionPinned(chatsByFolder[fid]'), 'pin partition wired into distribution');
    assert(ps.includes("fid === 'uncategorized' || searchTerm"), 'empty sections hidden during search');
    assert(ps.includes('reuseCachedNative(cached, block)'), 'cache reuse goes through the signature-aware check');
    assert(ps.includes('signature: block.textContent'), 'fresh parses store their signature');

    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes('chats.length, 3)'), 'main-view 3-cap applied via endIndex, upfront');
    assert(!rb.includes('children[i].remove()'), 'render-then-delete waste is gone');

    const cm = stripComments(extract('showContextMenu'));
    assert((cm.match(/menu\.remove\(\)/g) || []).length === 1, 'exactly one menu.remove() — inside cleanup(); action paths use cleanup()');
    assert(cm.includes('e.clientY') && cm.includes('e.clientX') && !cm.includes('e.pageY'), 'fixed-position menu uses client coords');
    assert(cm.includes('clampMenuToViewport(menu)'), 'clamp runs after append');
    assert(cm.includes('buildFolderList(settings, characterId)'), 'move-to list built existence-based');

    const iab = stripComments(extract('injectAddButton'));
    assert(iab.includes('clearSelection()'), 'entering Cards mode clears bulk selection');

    const fpe = stripComments(extract('findPreviewElement'));
    assert(fpe.indexOf('.select_chat_block_mes') < fpe.indexOf('querySelectorAll'), 'stable preview class tried before the heuristic');

    const mv = stripComments(extract('moveChatToCharacter'));
    assert(mv.includes('stripDeletedFromFolders(settings, sourceAvatar'), 'move-to-card uses the canonical cleanup');

    const initSrc = stripComments(extract('init'));
    assert(initSrc.includes('CHAT_RENAMED'), 'rename event subscribed (feature-detected)');
    assert(initSrc.includes('migrateChatRename(settings, charKey, oldId, newId)'), 'rename handler migrates bookkeeping');
    assert(initSrc.includes('activityData.fetchedAt = 0'), 'rename forces a branch-metadata refetch');

    // stamp-drift gate: manifest version must equal both in-code stamps
    const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
    assert(src.includes(`v${manifest.version} Loading...`), `init log stamp matches manifest (${manifest.version})`);
    assert(src.includes(` * v${manifest.version} - `), `header comment stamp matches manifest (${manifest.version})`);
}

console.log('[49] v0.13.1 workflow fixes: folder-view escape, search reveals matches, sentinel term');
{
    const ps = stripComments(extract('performSync'));
    // A: hide-empty can never hide the folder-view section (Back button lives there)
    assert(ps.includes("currentView !== 'folder' && (fid === 'uncategorized' || searchTerm)"),
        'hide-empty guarded out of folder view (zero-match search kept the Back button)');
    // C: active search force-opens sections that hold matches, render-only
    assert(ps.includes('if (searchTerm && sectionCount > 0)'), 'search-expand branch exists');
    const expandIdx = ps.indexOf('if (searchTerm && sectionCount > 0)');
    const expandBlock = ps.slice(expandIdx, ps.indexOf('}', ps.indexOf('dataset.collapsed', expandIdx)) + 1);
    assert(expandBlock.includes("container.style.display = ''"), 'matched section content forced visible');
    assert(expandBlock.includes("section.dataset.collapsed = 'false'"), 'chevron reflects the forced-open state');
    assert(!expandBlock.includes('saveSettings') && !expandBlock.includes('folders['),
        'persisted collapse flag untouched by the search override (render-only)');
    // B: lazy-scroll continuation carries the live term
    const io = stripComments(extract('initIntersectionObserver'));
    assert(io.includes('renderBatch(folderId, nextIndex, BATCH_SIZE, null, lastSearchTermSeen)'),
        'sentinel batches carry the active search term');
    assert(!io.includes('renderBatch(folderId, nextIndex, BATCH_SIZE);'),
        'no term-less continuation path remains');
}

console.log('[50] v0.14.0: open-chat-safe bulk delete');
{
    const partitionOpenChat = new Function(extract('partitionOpenChat') +
        '\nreturn partitionOpenChat;')();
    const isOpen = (f) => f === 'B.jsonl';
    const r = partitionOpenChat(['A.jsonl', 'B.jsonl', 'C.jsonl'], isOpen);
    assert(r.others.join(',') === 'A.jsonl,C.jsonl', 'non-open chats keep their order');
    assert(r.open.join(',') === 'B.jsonl', 'the open chat is separated out');
    assert(partitionOpenChat([], isOpen).open.length === 0, 'empty input safe');
    assert(partitionOpenChat(null, isOpen).others.length === 0, 'non-array input safe');
    const none = partitionOpenChat(['A', 'C'], isOpen);
    assert(none.open.length === 0 && none.others.length === 2, 'no open chat -> nothing special');

    // wiring: the open chat goes through ST's chat-aware teardown, LAST
    const bar = stripCommentsEarly(extract('updateBulkBar'));
    assert(bar.includes('partitionOpenChat(toDelete, isActiveChatFile)'),
        'bulk delete partitions on the open chat');
    const othersIdx = bar.indexOf('for (const fileName of others)');
    const openIdx = bar.indexOf('for (const fileName of open)');
    assert(othersIdx > -1 && openIdx > othersIdx, 'the open chat is deleted LAST');
    assert(bar.includes('s.replaceCurrentChat()'), 'solo open chat is followed by replaceCurrentChat()');
    assert(bar.includes('g.deleteGroupChat(groupId'), 'group open chat routes through deleteGroupChat');
    assert(bar.includes("typeof s.replaceCurrentChat !== 'function'") &&
           bar.includes("typeof g.deleteGroupChat !== 'function'"),
        'both repair paths are feature-detected');
    assert(bar.includes('skippedOpen'), 'a skipped open chat is reported, not silently dropped');
    // NEGATIVE: the unsafe *ByName helpers must not appear after the open loops
    assert(bar.indexOf('deleteGroupChatByName') < openIdx,
        'deleteGroupChatByName is never applied to the open chat');
    assert(bar.lastIndexOf('deleteCharacterChatByName') < bar.indexOf('s.replaceCurrentChat()'),
        'the solo open chat is repaired after its delete, not left bare');
}

console.log('[51] v0.14.0: one canonical scroll container');
{
    const gsc = new Function('document', 'getComputedStyle',
        extract('getScrollContainer') + '\nreturn getScrollContainer;')(document, dom.window.getComputedStyle);

    const popup = document.createElement('div');
    const mid = document.createElement('div');
    const proxy = document.createElement('div');
    popup.appendChild(mid); mid.appendChild(proxy);
    document.body.appendChild(popup);

    proxy.style.overflowY = 'auto';
    assert(gsc(popup, proxy) === proxy, 'proxy root itself is the scroller when it overflows');

    proxy.style.overflowY = 'visible';
    mid.style.overflowY = 'scroll';
    assert(gsc(popup, proxy) === mid, 'falls back to the nearest scrollable ancestor');

    mid.style.overflowY = 'visible';
    assert(gsc(popup, proxy) === proxy, 'nothing scrollable -> proxy root, never null');
    document.body.removeChild(popup);

    const ps = stripCommentsEarly(extract('performSync'));
    assert(ps.includes('const scroller = getScrollContainer(popup, proxyRoot)'), 'scroller resolved once');
    assert(ps.includes('initIntersectionObserver(scroller)'), 'lazy observer rooted on the real scroller');
    assert(ps.includes('scroller.scrollTop = lastScrollTop'), 'scroll restored on the real scroller');
    assert(ps.includes('scroller.scrollTop || 0'), 'scroll captured from the real scroller');
    assert(ps.includes('const sameList = listId === lastListIdentity'), 'same-list check gates the restore');
    assert(ps.includes('lastScrollTop = sameList ?'), 'a different list starts at the top');
    // NEGATIVE: the class that never existed, and the dead scroll target
    // comment-stripped: the name survives only in the comment explaining why
    assert(!stripCommentsEarly(src).includes('shadow_select_chat_popup_body'),
        'no code path looks for the never-existing popup-body class');
    assert(!ps.includes('body.scrollTop'), 'no scroll read/write on the non-scrolling popup element');
}

console.log('[52] v0.14.0: header toggles reconcile from state');
{
    const rhs = stripCommentsEarly(extract('refreshHeaderState'));
    assert(rhs.includes("classList.toggle('tmc_toggle_on', cardsMode)"), 'Cards button painted from cardsMode');
    assert(rhs.includes('familyView'), 'Families button painted from settings.familyView');
    assert(rhs.includes("classList.toggle('tmc_toggle_on', bulkMode)"), 'Select button painted from bulkMode');
    assert(rhs.includes('sel.value !== sortOrder'), 'sort dropdown reconciled too');
    const ps = stripCommentsEarly(extract('performSync'));
    // BOTH exit paths must paint: the cardsMode branch returns early, and it is
    // the very branch where the Cards toggle goes ON.
    assert((ps.match(/refreshHeaderState\(popup\)/g) || []).length === 2,
        'reconciliation runs on every sync path, including the cards-mode early return');
    const cardsIdx = ps.indexOf('if (cardsMode) {');
    const cardsBlock = ps.slice(cardsIdx, ps.indexOf('return;', cardsIdx));
    assert(cardsBlock.includes('refreshHeaderState(popup)'), 'cards mode paints the header before returning');
    assert(cardsBlock.includes("lastListIdentity = 'cards'"), 'cards mode owns its own list identity');
    // NEGATIVE: self-painting buttons are what desynced from the cardsMode
    // reset in syncPanelVisibility
    const iab = stripCommentsEarly(extract('injectAddButton'));
    assert(!iab.includes("cardsBtn.classList.toggle('tmc_toggle_on'"), 'Cards button does not self-paint');
    assert(!iab.includes("famBtn.classList.toggle('tmc_toggle_on'"), 'Families button does not self-paint');
    assert(!iab.includes('if (cardsMode) cardsBtn.classList.add'), 'no create-time Cards state');
    assert(!iab.includes('if (getSettings().familyView) famBtn.classList.add'), 'no create-time Families state');
}

console.log('[53] v0.14.0: numeric last-message date, locale-proof');
{
    const rbd = new Function(extract('resolveBlockDate') + '\nreturn resolveBlockDate;')();
    assert(rbd('Jul 30, 2026 12:34 PM', 'x') === Date.parse('Jul 30, 2026 12:34 PM'),
        'parses the native English date cell');
    assert(rbd('30 juillet 2026 12:34', 'Alice - 2026-07-30@12h34m56s') === Date.parse('2026-07-30T12:34:56'),
        'unparseable (non-English) cell falls back to the ST filename stamp');
    assert(rbd('', 'log 2026-07-30 notes') === Date.parse('2026-07-30'), 'plain ISO date in the name works');
    assert(rbd('', 'no date here') === 0, 'nothing parseable -> 0');
    assert(Number.isFinite(rbd('garbage', 'garbage')), 'never NaN (would poison Math.max and comparators)');
    assert(rbd(undefined, undefined) === 0, 'undefined inputs safe');

    const gcm = stripCommentsEarly(extract('getChatMetadata'));
    assert(gcm.includes('resolveBlockDate('), 'getChatMetadata uses the resolver');
    // NEGATIVE: the dead formatted-date path and the NaN parse are gone
    assert(!src.includes('function formatDate('), 'dead formatDate removed');
    assert(!src.includes('date: formatDate(dateStr)'), 'dead data.date field removed');
    assert(!gcm.includes('new Date(dateStr).getTime()'), 'the NaN-producing parse is gone');
}

console.log('[54] v0.14.0: search input resolved by id, not by position');
{
    const fsi = new Function('popup', extract('findSearchInput') + '\nreturn findSearchInput(popup);');
    const popup = document.createElement('div');
    // reproduce ST's real header order: the hidden import inputs come FIRST
    const decoy = document.createElement('input');
    decoy.type = 'text'; decoy.id = 'chat_import_file_type';
    const real = document.createElement('input');
    real.type = 'search'; real.id = 'select_chat_search';
    popup.appendChild(decoy); popup.appendChild(real);

    assert(fsi(popup) === real, 'picks ST search box even when a text input precedes it');
    // NEGATIVE: the old positional selector really did pick the decoy
    assert(popup.querySelector('input[type="search"], input[type="text"], .search_input') === decoy,
        'sanity: the old positional selector picked the hidden import field');

    const bare = document.createElement('div');
    const s2 = document.createElement('input'); s2.type = 'search';
    bare.appendChild(s2);
    assert(fsi(bare) === s2, 'falls back to type=search on exotic builds');
    assert(fsi(document.createElement('div')) === null, 'no input -> null, no throw');

    const ps = stripCommentsEarly(extract('performSync'));
    assert(ps.includes('findSearchInput(popup)'), 'performSync uses the resolver');
    assert(!ps.includes("input[type=\"text\"], .search_input"), 'no positional lookup left');
}

console.log('[55] v0.14.0: move-to-card cannot overwrite a target chat');
{
    const act = new Function('crypto',
        extract('freshIntegrity') + '\n' + extract('adaptChatForTarget') +
        '\nreturn adaptChatForTarget;')({ randomUUID: () => 'UUID-1' });
    const source = [
        { user_name: 'u', character_name: 'Alice', chat_metadata: { integrity: 'OLD-SLUG', main_chat: 'p' } },
        { is_user: true, name: 'u', mes: 'hi' },
        { is_user: false, name: 'Alice', mes: 'hello' },
        { is_user: false, name: 'Narrator', mes: '...' },
    ];
    const out = act(source, 'Alice', 'Bob');
    assert(out[0].character_name === 'Bob', 'header renamed to target card');
    assert(out[0].chat_metadata.integrity === 'UUID-1', 'the copy gets a FRESH integrity token');
    assert(out[0].chat_metadata.main_chat === 'p', 'other header metadata preserved');
    assert(source[0].chat_metadata.integrity === 'OLD-SLUG', 'source object not mutated');
    assert(out[2].name === 'Bob' && out[3].name === 'Narrator', 'only the source card speaker is renamed');
    assert(out[1].name === 'u', 'user messages untouched');
    const noMeta = act([{ user_name: 'u', character_name: 'Alice' }], 'Alice', 'Bob');
    assert(noMeta[0].character_name === 'Bob' && !('chat_metadata' in noMeta[0]),
        'a header without metadata does not gain an empty one');

    const mv = stripCommentsEarly(extract('moveChatToCharacter'));
    assert(mv.includes('await targetChatExists(target.avatar, candidate)'), 'destination existence is probed');
    assert(mv.includes('if (!destName)'), 'no free name found -> refuse rather than overwrite');
    // NEGATIVE: forcing the write is what disabled the server-side guard
    assert(!mv.includes('force: true'), 'the write is no longer forced');
    const tce = stripCommentsEarly(extract('targetChatExists'));
    assert(tce.includes('return true'), 'a failed probe counts as "exists" (never guesses toward overwrite)');
}

console.log('[56] v0.14.0: bookkeeping survives deletes that bypass TMC');
{
    const init = stripCommentsEarly(extract('init'));
    assert(init.includes("'CHAT_DELETED', 'GROUP_CHAT_DELETED'"), 'both delete events subscribed');
    assert(init.includes('stripDeletedFromFolders(settings, charKey, [id])'),
        'external deletes run the canonical cleanup');
    assert(init.includes('ctx.event_types[evName]'), 'feature-detected like the other event hooks');
}

console.log('[57] v0.14.0: bulk folder moves write once');
{
    const mc = stripCommentsEarly(extract('moveChats'));
    assert((mc.match(/saveSettings\(\)/g) || []).length === 1, 'exactly one settings write per bulk move');
    assert((mc.match(/scheduleSync\(\)/g) || []).length === 1, 'exactly one render per bulk move');
    assert(mc.includes('new Set(list.map(normalizeChatId))'), 'normalized on both sides');
    // NEGATIVE: no caller may loop the single-chat helper any more
    assert(!src.includes('files.forEach(f => moveChat(f'), 'new-folder path no longer loops moveChat');
    assert(!src.includes('selectedChats.forEach(file => moveChat(file'), 'bulk path no longer loops moveChat');
    const one = stripCommentsEarly(extract('moveChat'));
    assert(one.includes('moveChats([fileName], targetFolderId)') && !one.includes('saveSettings'),
        'single-chat move delegates — one implementation only');

    const settings = {
        folders: { f1: { name: 'A', chats: ['x', 'y.jsonl'] }, f2: { name: 'B', chats: [] } },
        characterFolders: { 'c.png': ['f1', 'f2'] },
    };
    const mk = new Function('settings',
        'function getSettings(){return settings;} function getCurrentCharacterId(){return "c.png";}' +
        'function saveSettings(){} function scheduleSync(){}' +
        extract('normalizeChatId') + '\n' + extract('moveChats') +
        '\nreturn moveChats;');
    mk(settings)(['x', 'y'], 'f2');
    assert(settings.folders.f1.chats.length === 0, 'both chats left the old folder (extension-insensitive)');
    assert(settings.folders.f2.chats.slice().sort().join(',') === 'x,y', 'both landed in the new folder, normalized');
}

console.log('[58] v0.14.0: proxy button clicks survive SVG-mode FontAwesome');
{
    const proxy = stripCommentsEarly(extract('createProxyBlock'));
    assert(proxy.includes('target.classList && target.classList.length'),
        'class fallback reads classList (defined on SVG elements too)');
    assert(proxy.includes('CSS.escape(parts[0])'), 'the derived selector is escaped');
    // NEGATIVE: className.split on an SVGAnimatedString threw, killing the click
    assert(!proxy.includes('target.className.split'), 'no className.split left');
    assert(!proxy.includes('clickedClass.split'), 'the duplicate last-resort path is gone');
}

console.log('[59] v0.14.0: CSS contract — every class the JS applies is styled');
{
    const css = readFileSync('./style.css', 'utf8');
    // Classes TMC creates itself and relies on for appearance. A class the JS
    // sets but the stylesheet never mentions is an invisible feature — exactly
    // what a DOM-built highlight span would have been without .tmc_hl.
    const owned = [
        'tmc_hl', 'tmc_toggle_on', 'tmc_btn_muted', 'tmc_flash', 'tmc_active',
        'tmc_pinned', 'tmc_selected', 'tmc_has_active', 'tmc_context_preview',
        'tmc_activity_hint', 'tmc_branch_chip', 'tmc_active_chip', 'tmc_pin_icon',
        'tmc_bulk_check', 'tmc_show_more', 'tmc_sentinel', 'tmc_back_btn',
        'tmc_cards_note', 'tmc_card_chat', 'tmc_card_chat_title',
        'tmc_card_chat_preview', 'tmc_charpicker_filter', 'tmc_ctx_current',
        'tmc_ctx_head', 'tmc_ctx_item', 'tmc_ctx_sep', 'tmc_mobile_menu',
        'tmc-live',
    ];
    const missing = owned.filter(c => src.includes(c) && !css.includes('.' + c));
    assert(missing.length === 0, 'no JS-applied class is left unstyled' +
        (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));

    // NEGATIVE side: no stylesheet rule may target a popup element that does
    // not exist in ST — that is how the scroll bug hid for three releases.
    assert(!css.includes('select_chat_popup_body'), 'no rules for the non-existent popup body element');
    assert(!css.includes('#tmc_proxy_root #select_chat_div'), 'no contradictory native-list rules');

    // the stylesheet stamp tracks the manifest like the two JS stamps do
    const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
    assert(css.includes(`Styles v${manifest.version} `), `stylesheet stamp matches manifest (${manifest.version})`);
}


console.log('[60] v0.15.0: buildBeginningPreview — beginning of the last output, not the tail');
{
    const buildBeginningPreview = new Function(extract('buildBeginningPreview') + '\nreturn buildBeginningPreview;')();
    const long = 'Start of a very long message. ' + 'x'.repeat(500);
    assert(buildBeginningPreview(['one', 'two', long]) === long.slice(0, 400),
        'long last message yields its FIRST 400 chars (server preview was its LAST 400)');
    assert(buildBeginningPreview(['older turn', '  Line one.\n\nLine   two.  ']) === 'Line one. Line two.',
        'whitespace/newlines collapsed into one visual line');
    assert(buildBeginningPreview(['short message']) === 'short message', 'short message passes through whole');
    assert(buildBeginningPreview([]) === null, 'no messages -> null (caller keeps native preview)');
    assert(buildBeginningPreview(null) === null, 'non-array -> null');
    assert(buildBeginningPreview(['   ']) === null, 'blank last message -> null');
    assert(buildBeginningPreview(['a', 'b'], 5) === 'b', 'maxChars respected');
}

console.log('[61] v0.15.0: enrichPreviewWithBeginning — fetch once, apply beginning, cache');
await (async () => {
    const findPreviewElement = new Function(extract('findPreviewElement') + '\nreturn findPreviewElement;')();
    const buildBeginningPreview = new Function(extract('buildBeginningPreview') + '\nreturn buildBeginningPreview;')();
    const ewbSrc = extract('enrichPreviewWithBeginning');
    const messages = ['first turn', 'second turn', 'The tavern door creaks open and she looks up.'];
    const beginningCache = {};
    let fetchCalls = 0;

    const mkBlock = () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="select_chat_block_filename">Chat 1</div><div class="select_chat_block_mes">\u2026tail of the last message</div>';
        document.body.appendChild(el); // isConnected === true
        return el;
    };
    const mkEnrich = (msgs) => new Function('fetchChatMessages', 'contentCacheKey', 'findPreviewElement', 'buildBeginningPreview', 'beginningPreviewCache',
        ewbSrc + '\nreturn enrichPreviewWithBeginning;')(
        async () => { fetchCalls++; return msgs; },
        (f) => 'C::' + f,
        findPreviewElement,
        buildBeginningPreview,
        beginningCache);
    const ewb = mkEnrich(messages);

    // A. cache miss -> one fetch -> beginning applied asynchronously
    const el1 = mkBlock();
    ewb(el1, 'Chat 1', null);
    assert(fetchCalls === 1, 'cache miss fetches once');
    await new Promise(r => setTimeout(r, 0));
    assert(el1.querySelector('.select_chat_block_mes').textContent === messages[2],
        'tail preview replaced with the BEGINNING of the last message');
    assert(beginningCache['C::Chat 1'] === messages[2], 'beginning stored in the cache');

    // B. cache hit -> synchronous apply, no refetch (no tail flash on re-render)
    const el2 = mkBlock();
    ewb(el2, 'Chat 1', null);
    assert(fetchCalls === 1, 'cache hit does not refetch');
    assert(el2.querySelector('.select_chat_block_mes').textContent === messages[2],
        'cache hit applies synchronously');

    // C. a block detached mid-flight (re-rendered) is never written
    const el3 = document.createElement('div');
    el3.innerHTML = '<div class="select_chat_block_mes">\u2026tail</div>';
    ewb(el3, 'Detached Chat', null);
    await new Promise(r => setTimeout(r, 0));
    assert(fetchCalls === 2, 'detached case still fetched (result is cached for the live block)');
    assert(el3.querySelector('.select_chat_block_mes').textContent === '\u2026tail',
        'detached block keeps its text');
    assert(beginningCache['C::Detached Chat'] === messages[2], 'its result still landed in the cache');

    // D. empty chat -> native preview kept, and never retried per sync
    const ewbEmpty = mkEnrich([]);
    const el4 = mkBlock();
    ewbEmpty(el4, 'Empty Chat', null);
    await new Promise(r => setTimeout(r, 0));
    assert(el4.querySelector('.select_chat_block_mes').textContent === '\u2026tail of the last message',
        'empty chat keeps the native preview');
    ewbEmpty(el4, 'Empty Chat', null);
    assert(fetchCalls === 3, 'known-empty is not refetched on every sync');
})();

console.log('[62] v0.15.0: beginning preview wired outside search; single-open click path');
{
    const cpb = stripComments(extract('createProxyBlock'));
    assert(/!searchTerm && \(\(chatData\.metadata && chatData\.metadata\.size\) \|\| 0\) <= ENRICH_MAX_BYTES\)\s*\{\s*enrichPreviewWithBeginning\(el, chatData\.fileName, getTitleEl\(el\)\)/.test(cpb),
        'beginning enrichment wired outside search with the shared size guard');
    assert((cpb.match(/const ENRICH_MAX_BYTES = 4 \* 1024 \* 1024;/g) || []).length === 1,
        'size budget hoisted and declared exactly once');

    assert(/e\.stopPropagation\(\);\s*openTarget\.click\(\)/.test(cpb),
        'forwarded open is the single open path (proxy click stopped from reaching the delegated opener)');
    assert(!cpb.includes('(findNativeBlock(chatData.fileName) || chatData.element).click();'),
        'unconditional forward-and-bubble is gone');
    assert(cpb.includes('openTarget.isConnected'),
        'only a live native block suppresses the bubble (stale block still opens via delegation)');
}

console.log('[63] v0.15.0: message events invalidate preview/content caches');
{
    const initSrc = stripComments(extract('init'));
    assert(/ctx\.eventSource\.on\(ctx\.event_types\[evName\], \(\) => \{[^}]*invalidateChatContentCaches\(\)/.test(initSrc),
        'message-event handler invalidates the caches');
    assert(!initSrc.includes('eventSource.on(ctx.event_types[evName], stampActivity)'),
        'bare stampActivity subscription replaced');

    const cc = { 'C::a': ['x'] }, order = ['C::a'], bc = { 'C::a': 'y' };
    // v0.16.0: invalidation now also bumps the cache generation and clears
    // the error-stamp map — both must be in the sandbox or the guard itself
    // would crash instead of asserting.
    const errs = { 'C::a': 123 }, promises = { 'C::a': {} };
    let gen = 7;
    const inv = new Function('chatContentCache', 'contentCacheOrder', 'beginningPreviewCache', 'chatContentErrAt', 'chatContentPromises', 'contentCacheGeneration',
        extract('invalidateChatContentCaches') + '\nreturn { run: invalidateChatContentCaches, gen: () => contentCacheGeneration };')(
        cc, order, bc, errs, promises, { valueOf: () => gen, toString: () => String(gen) });
    inv.run();
    assert(Object.keys(cc).length === 0 && order.length === 0 && Object.keys(bc).length === 0,
        'invalidation empties content cache, LRU order, and beginning cache');
    assert(Object.keys(errs).length === 0, 'v0.16.0: error-stamp map cleared too');
    assert(inv.gen() === 8, 'v0.16.0: generation bumped (in-flight fetches will refuse to cache)');
}

console.log('[64] v0.16.0: silent bulk-delete failure, LRU/slab sizing, stale write-back, fail-safe CSS');
{
    const css = readFileSync('./style.css', 'utf8');

    // (a) bulk delete can never fail silently: zero deleted (helpers worked,
    //     every call threw) must surface an error, not silence.
    const ub = stripComments(extract('updateBulkBar'));
    assert(ub.includes('deletedCount === 0 && !fallbackNeeded && toDelete.length > 0'),
        'zero-deleted bulk delete raises an explicit error toast');
    assert(!/delBtn\.click\(\);\s*\r?\n?\s*deletedCount\+\+/.test(ub),
        'native-click fallback no longer counts unconfirmed clicks as deleted');

    // (b) the content cache must be at least as large as the search render
    //     slab, or the LRU evicts mid-pass and every keystroke re-downloads.
    const cap64 = parseInt((src.match(/const CONTENT_CACHE_MAX = (\d+);/) || [])[1], 10);
    const slab64 = parseInt((src.match(/Math\.min\(sectionLen, Math\.max\((\d+),/) || [])[1], 10);
    assert(cap64 >= 30 && slab64 <= cap64,
        `content cache (${cap64}) >= search render slab (${slab64}) — no guaranteed LRU thrash`);

    // (c) a fetch in flight when the generation moved on must not write back.
    const fcm = stripComments(extract('fetchChatMessages'));
    assert(fcm.includes('const gen = contentCacheGeneration;'),
        'fetch captures the cache generation at start');
    assert(fcm.includes('if (gen === contentCacheGeneration) {'),
        'stale-generation results are served but never cached');
    assert(fcm.includes('CONTENT_ERROR_RETRY_MS') && fcm.includes('return null;'),
        'fetch failures are TTL-bounded and resolve to null (never "known-empty")');
    const epw = stripComments(extract('enrichPreviewWithBeginning'));
    assert(epw.includes('if (messages === null) return;'),
        'a failed fetch never poisons the beginning-preview cache');
    const epw2 = stripComments(extract('enrichPreviewWithContext'));
    assert(epw2.includes('if (messages === null) return;'),
        'a failed fetch never replaces the native preview either');

    // (d) fail-safe: the native list is hidden ONLY behind body.tmc-live,
    //     which the JS sets exclusively on render paths that completed.
    const ps64 = stripComments(extract('performSync'));
    const gateAdds = (ps64.match(/document\.body\.classList\.add\('tmc-live'\)/g) || []).length;
    assert(gateAdds >= 2, `render-success paths gate the CSS (${gateAdds} sites incl. the cards early return)`);
    // anchored to the MAIN render tail specifically: with three gate sites,
    // a bare >= 2 count could no longer catch the removal of any single one.
    // The main tail is the only gate followed by performSync's catch — the
    // cards early return also runs injectAddButton+refreshHeaderState, so
    // those two calls alone do not identify it.
    assert(/document\.body\.classList\.add\('tmc-live'\);\s*\} catch \(err\) \{/.test(ps64),
        'main render tail gates the CSS right before the sync catch');
    // and to the CARDS early return: its gate immediately precedes the list
    // identity handoff, which no other render path does.
    assert(/document\.body\.classList\.add\('tmc-live'\);\s*lastListIdentity = 'cards';/.test(ps64),
        'cards early return gates the CSS before handing off list identity');
    assert(css.includes('body.tmc-live #select_chat_div'),
        'native-list hiding rule is scoped under body.tmc-live');
    const selectorLines = css.split('\n')
        .map(l => l.trim())
        .filter(l => l.endsWith('{') && (l.includes('#select_chat_div') || l.includes('.select_chat_block_wrapper')));
    assert(selectorLines.length > 0 && selectorLines.every(l => l.startsWith('body.tmc-live')),
        'every native-list hiding selector is gated (an ungated rule would blank the popup if JS dies)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

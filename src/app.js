/* =========================================================================
   Grimoire — desktop Sorcery: Contested Realm deck builder (renderer)
   -------------------------------------------------------------------------
   All persistence (card database, images, decks) goes through the
   `window.grimoire` bridge exposed by preload.js, which talks to the
   Electron main process over IPC. The main process owns the actual API
   fetch, so this file never touches the network directly.
   ========================================================================= */

const ELEMENTS = ['Air', 'Earth', 'Fire', 'Water'];
const RARITY_CAP = { Ordinary: 4, Exceptional: 3, Elite: 2, Unique: 1 };
const TYPE_ORDER = { Avatar: 0, Site: 1, Minion: 2, Magic: 3, Artifact: 4, Aura: 5 };
const DECK_SECTIONS = [
  { type: 'Avatar', label: 'Avatar' },
  { type: 'Site', label: 'Sites (Atlas)' },
  { type: 'Minion', label: 'Minions' },
  { type: 'Magic', label: 'Magic' },
  { type: 'Artifact', label: 'Artifacts' },
  { type: 'Aura', label: 'Auras' },
];

// Each entry drives one operator+number row in the "Stats & thresholds"
// filter group, and reads/writes state.filters.numeric[key].
const NUMERIC_FILTERS = [
  { key: 'cost', label: 'Mana cost', accessor: (c) => c.cost },
  { key: 'anyThreshold', label: 'Any threshold', accessor: (c) => ELEMENTS.map((el) => c.thresholds[el] || 0) },
  { key: 'airThreshold', label: 'Air threshold', accessor: (c) => c.thresholds.Air || 0 },
  { key: 'earthThreshold', label: 'Earth threshold', accessor: (c) => c.thresholds.Earth || 0 },
  { key: 'fireThreshold', label: 'Fire threshold', accessor: (c) => c.thresholds.Fire || 0 },
  { key: 'waterThreshold', label: 'Water threshold', accessor: (c) => c.thresholds.Water || 0 },
  { key: 'attack', label: 'Attack', accessor: (c) => c.power },
  { key: 'defense', label: 'Defense', accessor: (c) => c.life },
];
const NUMERIC_OPS = [
  { value: '=', label: 'Equals' },
  { value: '>=', label: 'At least' },
  { value: '<=', label: 'At most' },
  { value: '>', label: 'Greater than' },
  { value: '<', label: 'Less than' },
];

function emptyNumericFilters() {
  const out = {};
  NUMERIC_FILTERS.forEach((f) => { out[f.key] = { op: '=', val: '' }; });
  return out;
}

const state = {
  db: null, // { fetchedAt, source, count, cards: [] }
  filters: {
    name: '', text: '', artist: '',
    types: new Set(), subtype: '', set: '',
    includeElements: new Set(), excludeElements: new Set(),
    rarities: new Set(),
    numeric: emptyNumericFilters(),
    sort: 'name',
  },
  images: { baseUrl: null, set: new Set() },
};

const deck = {
  name: 'Untitled Deck',
  format: 'Constructed',
  entries: {}, // id -> { qty, name, type, elements, cost, rarity }
  collection: {}, // id -> { qty, name, type, elements, cost, rarity } — cards held outside the deck (max 10 in Constructed)
};

const COLLECTION_CAP = 10;

/* ---------------------------------------------------------------------- *
 * Utilities
 * ---------------------------------------------------------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function slugify(str) {
  return String(str || 'card')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'card';
}

function titleCase(str) {
  if (!str) return str;
  return String(str).charAt(0).toUpperCase() + String(str).slice(1).toLowerCase();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function formatWhen(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

/* ---------------------------------------------------------------------- *
 * Card normalization — defensive against unknown/changing API fields
 * ---------------------------------------------------------------------- */

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function deepPick(raw, keys) {
  const sources = [raw, raw && raw.guardian, raw && raw.card, raw && raw.attributes, raw && raw.fields]
    .filter((s) => s && typeof s === 'object');
  for (const src of sources) {
    const v = pick(src, keys);
    if (v !== undefined) return v;
  }
  return undefined;
}

function extractElements(raw) {
  const src = deepPick(raw, ['elements', 'element', 'threshold', 'thresholds']);
  const found = new Set();
  if (Array.isArray(src)) {
    src.forEach((v) => {
      const name = titleCase(typeof v === 'string' ? v : v && v.name);
      if (ELEMENTS.includes(name)) found.add(name);
    });
  } else if (src && typeof src === 'object') {
    Object.entries(src).forEach(([k, v]) => {
      const name = titleCase(k);
      if (ELEMENTS.includes(name) && Number(v) > 0) found.add(name);
    });
  } else if (typeof src === 'string') {
    src.split(/[^a-zA-Z]+/).forEach((part) => {
      const name = titleCase(part);
      if (ELEMENTS.includes(name)) found.add(name);
    });
  }
  return Array.from(found);
}

function extractThresholds(raw) {
  const src = deepPick(raw, ['thresholds', 'threshold']);
  const amounts = {};
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    Object.entries(src).forEach(([k, v]) => {
      const name = titleCase(k);
      if (ELEMENTS.includes(name) && Number(v) > 0) amounts[name] = Number(v);
    });
  }
  return amounts;
}

function extractSets(raw) {
  const sets = Array.isArray(raw && raw.sets) ? raw.sets : [];
  return sets
    .map((s) => ({ name: s && s.name, releasedAt: s && s.releasedAt }))
    .filter((s) => s.name);
}

function extractArtists(raw) {
  const sets = Array.isArray(raw && raw.sets) ? raw.sets : [];
  const found = new Set();
  sets.forEach((s) => {
    (s.variants || s.printings || []).forEach((v) => { if (v && v.artist) found.add(v.artist); });
  });
  return Array.from(found);
}

function extractSlug(raw, fallbackName, idx) {
  const direct = deepPick(raw, ['slug', 'id', 'uuid', 'cardId']);
  if (direct) return String(direct);
  const sets = deepPick(raw, ['sets', 'printings']);
  if (Array.isArray(sets) && sets[0]) {
    const variants = sets[0].variants || sets[0].printings;
    if (Array.isArray(variants) && variants[0] && variants[0].slug) return String(variants[0].slug);
    if (sets[0].slug) return String(sets[0].slug);
  }
  return `${slugify(fallbackName)}-${idx}`;
}

function normalizeRawCard(raw, idx) {
  const name = String(firstDefined(deepPick(raw, ['name', 'title', 'cardName']), `Unnamed Card ${idx}`));
  const type = titleCase(firstDefined(deepPick(raw, ['type', 'category', 'cardType', 'guardianType']), ''));
  const rarity = titleCase(firstDefined(deepPick(raw, ['rarity', 'rarityName']), ''));
  const costRaw = firstDefined(deepPick(raw, ['cost', 'mana', 'manaCost']));
  const cost = Number.isFinite(Number(costRaw)) ? Number(costRaw) : null;
  const powerRaw = firstDefined(deepPick(raw, ['attack', 'power']));
  const power = Number.isFinite(Number(powerRaw)) ? Number(powerRaw) : null;
  // Note: the raw 'life' field is a constant (always 20, the game's starting
  // life total) that the API leaks onto non-combat cards. The real per-card
  // toughness stat is always 'defence'/'defense' when a card has one.
  const lifeRaw = firstDefined(deepPick(raw, ['defence', 'defense']));
  const life = Number.isFinite(Number(lifeRaw)) ? Number(lifeRaw) : null;
  const text = String(firstDefined(deepPick(raw, ['text', 'rulesText', 'description', 'oracleText']), ''));
  let subTypes = firstDefined(deepPick(raw, ['subTypes', 'subtypes', 'subType']), []);
  if (typeof subTypes === 'string') subTypes = subTypes.split(/[/,]/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(subTypes)) subTypes = [];
  const elements = extractElements(raw);
  const thresholds = extractThresholds(raw);
  const slug = extractSlug(raw, name, idx);
  const setInfo = extractSets(raw);
  const sets = setInfo.map((s) => s.name);
  const artists = extractArtists(raw);

  return { id: slug, name, type, rarity, cost, power, life, text, subTypes, elements, thresholds, slug, sets, setInfo, artists, raw };
}

/* ---------------------------------------------------------------------- *
 * Card images — matched against whatever's actually in the images folder
 * ---------------------------------------------------------------------- */

function candidateImageFilenames(card) {
  const names = new Set();
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  const sets = (card.raw && (card.raw.sets || card.raw.printings)) || [];
  sets.forEach((s) => {
    (s.variants || s.printings || []).forEach((v) => {
      if (v && v.slug) exts.forEach((ext) => names.add(`${v.slug}.${ext}`));
    });
  });
  const simple = slugify(card.name);
  exts.forEach((ext) => names.add(`${simple}.${ext}`));
  exts.forEach((ext) => names.add(`${card.slug}.${ext}`));
  return Array.from(names);
}

function resolveCardImageUrl(card) {
  if (!state.images.baseUrl || state.images.set.size === 0) return null;
  const candidates = candidateImageFilenames(card);
  for (const name of candidates) {
    if (state.images.set.has(name.toLowerCase())) {
      return state.images.baseUrl + encodeURIComponent(name);
    }
  }
  return null;
}

async function loadImagesInfo() {
  try {
    const info = await window.grimoire.getImagesInfo();
    state.images.baseUrl = info.baseUrl;
    state.images.set = new Set((info.files || []).map((f) => f.toLowerCase()));
  } catch (err) {
    console.warn('Could not load images info', err);
  }
}

/* ---------------------------------------------------------------------- *
 * Card database — via IPC to the main process
 * ---------------------------------------------------------------------- */

function setDbStatus(dotClass, text) {
  $('#dbDot').className = 'db-dot ' + dotClass;
  $('#dbStatusText').textContent = text;
}

function applyLoadedDb(dbPayload) {
  const rawCards = dbPayload.cards || [];
  const cards = rawCards.map(normalizeRawCard);
  state.db = { fetchedAt: dbPayload.fetchedAt, source: dbPayload.source, count: cards.length, cards };

  if (cards.length === 0) {
    setDbStatus('bad', 'No cards loaded. Try Update or Import DB file.');
  } else if (dbPayload.source === 'bundled') {
    setDbStatus('ok', `${cards.length} cards • bundled default database`);
  } else {
    setDbStatus('ok', `${cards.length} cards • ${dbPayload.source === 'import' ? 'imported' : 'updated'} ${formatWhen(dbPayload.fetchedAt) || ''}`);
  }
  populateFilterDropdowns();
  applyFiltersAndRender();
  renderDeckPanel();
}

async function initDb() {
  setDbStatus('warn', 'Loading card database…');
  try {
    const dbPayload = await window.grimoire.loadDatabase();
    applyLoadedDb(dbPayload);
  } catch (err) {
    console.error(err);
    setDbStatus('bad', 'Could not load the card database.');
  }
}

async function refreshDbFromApi({ manual = false } = {}) {
  if (manual) setDbStatus('warn', 'Checking the Sorcery API…');
  const res = await window.grimoire.updateDatabase();
  if (res.ok) {
    applyLoadedDb(res.db);
    if (manual) toast(`Card database updated — ${res.db.cards.length} cards loaded.`);
  } else {
    if (state.db) setDbStatus('ok', `${state.db.count} cards • cached ${formatWhen(state.db.fetchedAt) || ''}`);
    if (manual) {
      toast(res.canceled ? 'Update canceled.' : `Couldn't reach the Sorcery API (${res.error}). This is normal if you're offline — your existing database is untouched.`);
    }
  }
}

async function importDb() {
  const res = await window.grimoire.importDatabase();
  if (res.ok) {
    applyLoadedDb(res.db);
    toast(`Imported ${res.db.cards.length} cards.`);
  } else if (!res.canceled) {
    toast(`Import failed: ${res.error}`);
  }
}

/* ---------------------------------------------------------------------- *
 * Filtering / rendering the card grid
 * ---------------------------------------------------------------------- */

function populateFilterDropdowns() {
  if (!state.db) return;

  const setDates = new Map();
  state.db.cards.forEach((c) => {
    (c.setInfo || []).forEach((s) => {
      if (!setDates.has(s.name) || (s.releasedAt && s.releasedAt < setDates.get(s.name))) {
        setDates.set(s.name, s.releasedAt || '');
      }
    });
  });
  const sets = Array.from(setDates.keys()).sort((a, b) => (setDates.get(a) || '').localeCompare(setDates.get(b) || ''));

  const subtypes = Array.from(new Set(state.db.cards.flatMap((c) => c.subTypes || []).filter(Boolean))).sort();

  const setSel = $('#setFilter');
  const subtypeSel = $('#subtypeFilter');
  const prevSet = setSel.value;
  const prevSubtype = subtypeSel.value;

  setSel.innerHTML = ''; setSel.appendChild(new Option('Any set', ''));
  sets.forEach((s) => setSel.appendChild(new Option(s, s)));
  subtypeSel.innerHTML = ''; subtypeSel.appendChild(new Option('Any sub-type', ''));
  subtypes.forEach((s) => subtypeSel.appendChild(new Option(s, s)));

  if (sets.includes(prevSet)) setSel.value = prevSet;
  if (subtypes.includes(prevSubtype)) subtypeSel.value = prevSubtype;
}

function buildNumericFilterUI() {
  const container = $('#numericFilters');
  container.innerHTML = '';
  NUMERIC_FILTERS.forEach(({ key, label }) => {
    const row = document.createElement('div');
    row.className = 'numeric-row';

    const name = document.createElement('span');
    name.className = 'numeric-label';
    name.textContent = label;

    const opSel = document.createElement('select');
    opSel.className = 'input input-op';
    NUMERIC_OPS.forEach((o) => opSel.appendChild(new Option(o.label, o.value)));
    opSel.addEventListener('change', (e) => {
      state.filters.numeric[key].op = e.target.value;
      applyFiltersAndRender();
    });

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.className = 'input input-num';
    numInput.placeholder = '#';
    numInput.addEventListener('input', (e) => {
      state.filters.numeric[key].val = e.target.value;
      applyFiltersAndRender();
    });

    row.append(name, opSel, numInput);
    container.appendChild(row);
  });
}

function numericMatch(value, filter) {
  if (filter.val === '' || filter.val === null || filter.val === undefined) return true;
  const n = Number(filter.val);
  if (!Number.isFinite(n)) return true;
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.some((v) => {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return false;
    const cv = Number(v);
    switch (filter.op) {
      case '>=': return cv >= n;
      case '<=': return cv <= n;
      case '>': return cv > n;
      case '<': return cv < n;
      default: return cv === n;
    }
  });
}

function sorterFor(mode) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (mode === 'cost') return (a, b) => (a.cost ?? 999) - (b.cost ?? 999) || byName(a, b);
  if (mode === 'type') return (a, b) => (a.type || '').localeCompare(b.type || '') || byName(a, b);
  if (mode === 'rarity') return (a, b) => (a.rarity || '').localeCompare(b.rarity || '') || byName(a, b);
  return byName;
}

function applyFiltersAndRender() {
  if (!state.db) {
    renderCardGrid([]);
    $('#resultCount').textContent = 'No card database loaded';
    return;
  }
  const {
    name, text, artist, types, subtype, set,
    includeElements, excludeElements, rarities, numeric, sort,
  } = state.filters;
  const nameQ = name.trim().toLowerCase();
  const textQ = text.trim().toLowerCase();
  const artistQ = artist.trim().toLowerCase();

  let list = state.db.cards.filter((c) => {
    if (nameQ && !c.name.toLowerCase().includes(nameQ)) return false;
    if (textQ && !c.text.toLowerCase().includes(textQ)) return false;
    if (artistQ && !(c.artists && c.artists.some((a) => a.toLowerCase().includes(artistQ)))) return false;

    if (types.size && !types.has(c.type)) return false;
    if (subtype && !(c.subTypes && c.subTypes.includes(subtype))) return false;
    if (set && !(c.sets && c.sets.includes(set))) return false;
    if (rarities.size && !rarities.has(c.rarity)) return false;

    if (includeElements.size) {
      const isNeutral = !c.elements || c.elements.length === 0;
      const matches = (isNeutral && includeElements.has('None')) || (c.elements && c.elements.some((e) => includeElements.has(e)));
      if (!matches) return false;
    }
    if (excludeElements.size) {
      const isNeutral = !c.elements || c.elements.length === 0;
      const excluded = (isNeutral && excludeElements.has('None')) || (c.elements && c.elements.some((e) => excludeElements.has(e)));
      if (excluded) return false;
    }

    for (const nf of NUMERIC_FILTERS) {
      if (!numericMatch(nf.accessor(c), numeric[nf.key])) return false;
    }

    return true;
  });
  list.sort(sorterFor(sort));
  renderCardGrid(list);
  $('#resultCount').textContent = `${list.length} card${list.length === 1 ? '' : 's'}`;
}

function elementSpineCSS(elements) {
  if (!elements || elements.length === 0) return 'var(--none)';
  const colorVar = { Air: 'var(--air)', Earth: 'var(--earth)', Fire: 'var(--fire)', Water: 'var(--water)' };
  if (elements.length === 1) return colorVar[elements[0]];
  const stops = elements.map((e) => colorVar[e]);
  const pct = 100 / stops.length;
  return `linear-gradient(180deg, ${stops.map((c, i) => `${c} ${i * pct}%, ${c} ${(i + 1) * pct}%`).join(', ')})`;
}

// Units have "power" — a single number, or split into attack power (damage
// dealt) and defense power (damage that must be taken to kill it) when the
// two differ. The raw 'attack'/'defence' fields are always both present or
// both absent for a given card, so no partial case is needed here.
function formatPower(card) {
  if (card.power === null || card.life === null) return null;
  if (card.power === card.life) return `Power ${card.power}`;
  return `Attack ${card.power} · Defense ${card.life}`;
}

function formatThresholds(thresholds) {
  return ELEMENTS
    .filter((el) => thresholds[el] > 0)
    .map((el) => `${el} ×${thresholds[el]}`)
    .join('  ·  ');
}

function renderCardGrid(list) {
  const grid = $('#cardGrid');
  grid.innerHTML = '';
  if (!state.db) {
    grid.innerHTML = '<div class="empty-state">Loading the grimoire\'s index…</div>';
    return;
  }
  if (list.length === 0) {
    grid.innerHTML = '<div class="empty-state">No cards match your filters.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((card) => frag.appendChild(buildCardTile(card)));
  grid.appendChild(frag);
}

function buildCardTile(card) {
  const tile = document.createElement('div');
  tile.className = 'card-tile';
  tile.dataset.id = card.id;
  tile.style.setProperty('--spine', elementSpineCSS(card.elements));

  const artUrl = resolveCardImageUrl(card);
  if (artUrl) {
    tile.classList.add('has-art');
    tile.tabIndex = 0;
    const img = document.createElement('img');
    img.className = 'ct-art';
    img.src = artUrl;
    img.alt = card.name;
    img.loading = 'lazy';
    img.onerror = () => { img.remove(); tile.classList.remove('has-art'); tile.tabIndex = -1; buildFallbackInfo(tile, card); };
    tile.appendChild(img);
    tile.appendChild(buildCardOverlay(card));
  } else {
    buildFallbackInfo(tile, card);
  }

  const entry = deck.entries[card.id];
  if (entry && entry.qty > 0) {
    const badge = document.createElement('div');
    badge.className = 'ct-qty-badge';
    badge.textContent = entry.qty;
    tile.appendChild(badge);
  }

  tile.addEventListener('click', (e) => addToDeck(card, e.shiftKey ? 4 : 1));
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardModal(card); });

  return tile;
}

// Plain always-visible name/type/stats block, used only when a card has no
// artwork to show (nothing to reveal on hover in that case).
function buildFallbackInfo(tile, card) {
  const cost = document.createElement('div');
  cost.className = 'ct-cost';
  cost.textContent = card.cost ?? '–';
  tile.appendChild(cost);

  const nameEl = document.createElement('div');
  nameEl.className = 'ct-name';
  nameEl.textContent = card.name;
  tile.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'ct-meta';
  meta.textContent = [card.type, card.rarity].filter(Boolean).join(' · ') || 'Unknown type';
  tile.appendChild(meta);

  const powerLabel = formatPower(card);
  if (powerLabel) {
    const stats = document.createElement('div');
    stats.className = 'ct-stats';
    stats.textContent = powerLabel;
    tile.appendChild(stats);
  }
}

// Hidden-until-hover readout shown over the artwork: name, type, cost,
// stats, elements, and rules text.
function buildCardOverlay(card) {
  const overlay = document.createElement('div');
  overlay.className = 'ct-overlay';

  const nameEl = document.createElement('div');
  nameEl.className = 'ov-name';
  nameEl.textContent = card.name;
  overlay.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'ov-meta';
  meta.textContent = [card.type, card.rarity].filter(Boolean).join(' · ') || 'Unknown type';
  overlay.appendChild(meta);

  const statParts = [
    card.cost !== null ? `Cost ${card.cost}` : null,
    formatPower(card),
  ].filter(Boolean);
  if (statParts.length) {
    const stats = document.createElement('div');
    stats.className = 'ov-stats';
    stats.textContent = statParts.join('  ·  ');
    overlay.appendChild(stats);
  }

  if (card.type === 'Site' && card.thresholds && Object.keys(card.thresholds).length) {
    const thresholdsEl = document.createElement('div');
    thresholdsEl.className = 'ov-thresholds';
    thresholdsEl.textContent = `Provides: ${formatThresholds(card.thresholds)}`;
    overlay.appendChild(thresholdsEl);
  }

  const tags = [
    card.elements && card.elements.length ? card.elements.join('/') : null,
    card.subTypes && card.subTypes.length ? card.subTypes.join(', ') : null,
  ].filter(Boolean);
  if (tags.length) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'ov-tags';
    tagsEl.textContent = tags.join(' — ');
    overlay.appendChild(tagsEl);
  }

  if (card.text) {
    const text = document.createElement('div');
    text.className = 'ov-text';
    text.textContent = card.text;
    overlay.appendChild(text);
  }

  return overlay;
}

function refreshGridQtyBadges() { applyFiltersAndRender(); }

/* ---------------------------------------------------------------------- *
 * Card detail modal
 * ---------------------------------------------------------------------- */

function openCardModal(card) {
  const modal = $('#cardModal');
  modal.innerHTML = '';

  const close = document.createElement('button');
  close.className = 'm-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.onclick = closeModal;
  modal.appendChild(close);

  const artUrl = resolveCardImageUrl(card);
  if (artUrl) {
    const wrap = document.createElement('div'); wrap.className = 'm-art-wrap';
    const img = document.createElement('img');
    img.className = 'm-art'; img.src = artUrl; img.alt = card.name;
    img.onerror = () => img.remove();
    wrap.appendChild(img);
    modal.appendChild(wrap);
  }

  const h2 = document.createElement('h2'); h2.textContent = card.name;
  modal.appendChild(h2);

  const meta = document.createElement('div'); meta.className = 'm-meta';
  meta.textContent = [
    card.type, card.rarity,
    card.cost !== null ? `Cost ${card.cost}` : null,
    formatPower(card),
    card.elements && card.elements.length ? card.elements.join('/') : 'Neutral',
    card.subTypes && card.subTypes.length ? card.subTypes.join(', ') : null,
  ].filter(Boolean).join(' — ');
  modal.appendChild(meta);

  if (card.type === 'Site' && card.thresholds && Object.keys(card.thresholds).length) {
    const thresholdsEl = document.createElement('div');
    thresholdsEl.className = 'm-meta';
    thresholdsEl.textContent = `Provides: ${formatThresholds(card.thresholds)}`;
    modal.appendChild(thresholdsEl);
  }

  if (card.text) {
    const text = document.createElement('div'); text.className = 'm-text'; text.textContent = card.text;
    modal.appendChild(text);
  }

  const actions = document.createElement('div'); actions.className = 'm-actions';
  const addBtn = document.createElement('button'); addBtn.className = 'btn btn-primary'; addBtn.textContent = 'Add to deck';
  addBtn.onclick = () => addToDeck(card, 1);
  actions.appendChild(addBtn);
  const addCollBtn = document.createElement('button'); addCollBtn.className = 'btn btn-ghost'; addCollBtn.textContent = 'Add to collection';
  addCollBtn.onclick = () => addToCollection(card, 1);
  actions.appendChild(addCollBtn);
  modal.appendChild(actions);

  $('#modalBackdrop').classList.add('show');
}

function closeModal() { $('#modalBackdrop').classList.remove('show'); }

/* ---------------------------------------------------------------------- *
 * Deck management
 * ---------------------------------------------------------------------- */

function persistDeck() {
  window.grimoire.saveCurrentDeck({ name: deck.name, format: deck.format, entries: deck.entries, collection: deck.collection });
}

async function loadDeckFromStorage() {
  try {
    const saved = await window.grimoire.loadCurrentDeck();
    if (saved) {
      deck.name = saved.name || deck.name;
      deck.format = saved.format || deck.format;
      deck.entries = saved.entries || {};
      deck.collection = saved.collection || {};
    }
  } catch (err) {
    console.warn('Could not load saved deck', err);
  }
  $('#deckName').value = deck.name;
  if ([...$('#deckFormat').options].some((o) => o.value === deck.format)) $('#deckFormat').value = deck.format;
}

// Rarity limits apply to the combined copies of a card across the deck and
// the collection (they're both "your cards", just different zones).
function combinedCopyCount(id) {
  return (deck.entries[id]?.qty || 0) + (deck.collection[id]?.qty || 0);
}

function warnIfOverRarityCap(id, rarity, name) {
  const cap = RARITY_CAP[rarity];
  if (!cap) return;
  const total = combinedCopyCount(id);
  if (total > cap) {
    toast(`Heads up: ${name} is now at ${total} copies between your deck and collection — the usual limit for ${rarity} cards is ${cap}.`);
  }
}

function addToDeck(card, qty) {
  const existing = deck.entries[card.id];
  const entry = existing || { qty: 0, name: card.name, type: card.type, elements: card.elements, cost: card.cost, rarity: card.rarity };
  entry.qty += qty;
  deck.entries[card.id] = entry;
  warnIfOverRarityCap(card.id, card.rarity, card.name);
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function incEntry(id) {
  const e = deck.entries[id]; if (!e) return;
  e.qty += 1;
  warnIfOverRarityCap(id, e.rarity, e.name);
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}
function decEntry(id) {
  const e = deck.entries[id]; if (!e) return;
  e.qty -= 1;
  if (e.qty <= 0) delete deck.entries[id];
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}
function removeEntry(id) {
  delete deck.entries[id];
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function clearDeck() {
  if (!Object.keys(deck.entries).length) return;
  if (!confirm("Clear every card from this deck? This can't be undone.")) return;
  deck.entries = {};
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function deckEntryList() {
  return Object.entries(deck.entries).map(([id, e]) => ({ id, ...e }));
}

function warnIfOverCollectionCap() {
  const total = collectionTotal();
  if (total > COLLECTION_CAP) {
    toast(`Heads up: your collection has ${total} cards — Constructed limits it to ${COLLECTION_CAP}.`);
  }
}

function addToCollection(card, qty) {
  const existing = deck.collection[card.id];
  const entry = existing || { qty: 0, name: card.name, type: card.type, elements: card.elements, cost: card.cost, rarity: card.rarity };
  entry.qty += qty;
  deck.collection[card.id] = entry;
  warnIfOverRarityCap(card.id, card.rarity, card.name);
  warnIfOverCollectionCap();
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function incCollectionEntry(id) {
  const e = deck.collection[id]; if (!e) return;
  e.qty += 1;
  warnIfOverRarityCap(id, e.rarity, e.name);
  warnIfOverCollectionCap();
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}
function decCollectionEntry(id) {
  const e = deck.collection[id]; if (!e) return;
  e.qty -= 1;
  if (e.qty <= 0) delete deck.collection[id];
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}
function removeCollectionEntry(id) {
  delete deck.collection[id];
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function clearCollection() {
  if (!Object.keys(deck.collection).length) return;
  if (!confirm("Clear every card from your collection? This can't be undone.")) return;
  deck.collection = {};
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function collectionEntryList() {
  return Object.entries(deck.collection).map(([id, e]) => ({ id, ...e }));
}

function collectionTotal() {
  return collectionEntryList().reduce((sum, e) => sum + e.qty, 0);
}

// Drag-and-drop between the deck list and the collection list moves the
// whole stack for that card (all copies) from one zone to the other.
function moveEntryToZone(id, fromZone, toZone) {
  if (fromZone === toZone) return;
  const fromMap = fromZone === 'deck' ? deck.entries : deck.collection;
  const toMap = toZone === 'deck' ? deck.entries : deck.collection;
  const entry = fromMap[id];
  if (!entry) return;
  delete fromMap[id];
  const existing = toMap[id];
  if (existing) existing.qty += entry.qty;
  else toMap[id] = { ...entry };

  warnIfOverRarityCap(id, entry.rarity, entry.name);
  if (toZone === 'collection') warnIfOverCollectionCap();
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
}

function computeTotals() {
  const rows = deckEntryList();
  let avatar = 0, sites = 0, all = 0;
  rows.forEach((r) => {
    all += r.qty;
    if (r.type === 'Avatar') avatar += r.qty;
    else if (r.type === 'Site') sites += r.qty;
  });
  return { avatar, sites, spells: all - avatar - sites, all };
}

function computeElementWeights() {
  const w = { Air: 0, Earth: 0, Fire: 0, Water: 0 };
  deckEntryList().forEach((r) => (r.elements || []).forEach((el) => { if (w[el] !== undefined) w[el] += r.qty; }));
  return w;
}

function renderDeckPanel() {
  deck.name = $('#deckName').value || 'Untitled Deck';
  deck.format = $('#deckFormat').value;

  const rows = deckEntryList();

  const list = $('#deckList');
  list.innerHTML = '';
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-state">Your deck is empty. Click cards on the left to add them.</div>';
  } else {
    const frag = document.createDocumentFragment();
    const byType = new Map();
    rows.forEach((r) => {
      const key = r.type || '';
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(r);
    });

    const knownTypes = new Set(DECK_SECTIONS.map((s) => s.type));
    const sections = [...DECK_SECTIONS];
    Array.from(byType.keys()).filter((t) => !knownTypes.has(t)).sort().forEach((t) => {
      sections.push({ type: t, label: t || 'Other' });
    });

    sections.forEach((section) => {
      const entries = byType.get(section.type);
      if (!entries || entries.length === 0) return;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      frag.appendChild(buildDeckSectionHeader(section.label, entries.reduce((sum, e) => sum + e.qty, 0)));
      entries.forEach((r) => frag.appendChild(buildDeckRow(r, { dec: decEntry, inc: incEntry, remove: removeEntry, zone: 'deck' })));
    });

    list.appendChild(frag);
  }

  const t = computeTotals();
  $('#totAvatar').textContent = t.avatar;
  $('#totSites').textContent = t.sites;
  $('#totSpells').textContent = t.spells;
  $('#totAll').textContent = t.all;

  const weights = computeElementWeights();
  const max = Math.max(1, ...Object.values(weights));
  $all('.ledger-bar').forEach((bar) => {
    const el = bar.dataset.el;
    bar.querySelector('span').style.width = `${(weights[el] / max) * 100}%`;
    bar.title = `${el}: ${weights[el]}`;
  });

  renderCollectionPanel();
}

function renderCollectionPanel() {
  const rows = collectionEntryList().sort((a, b) => a.name.localeCompare(b.name));

  const list = $('#collectionList');
  list.innerHTML = '';
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-state">Empty. Add cards from a card\'s detail view.</div>';
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach((r) => frag.appendChild(buildDeckRow(r, { dec: decCollectionEntry, inc: incCollectionEntry, remove: removeCollectionEntry, zone: 'collection' })));
    list.appendChild(frag);
  }

  const total = collectionTotal();
  const countEl = $('#collectionCount');
  countEl.textContent = `${total}/${COLLECTION_CAP}`;
  countEl.classList.toggle('over-cap', total > COLLECTION_CAP);
}

function buildDeckSectionHeader(label, count) {
  const header = document.createElement('div');
  header.className = 'deck-section-head';
  const name = document.createElement('span');
  name.textContent = label;
  const qty = document.createElement('span');
  qty.className = 'deck-section-count';
  qty.textContent = count;
  header.append(name, qty);
  return header;
}

function findCardById(id) {
  return (state.db && state.db.cards.find((c) => c.id === id)) || null;
}

function buildDeckRow(entry, handlers) {
  const row = document.createElement('div');
  row.className = 'deck-row';
  row.draggable = true;
  row.dataset.id = entry.id;

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ id: entry.id, zone: handlers.zone }));
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));

  row.addEventListener('click', (e) => {
    if (e.target.closest('.dr-qty')) return;
    const card = findCardById(entry.id);
    if (card) openCardModal(card);
  });

  const spine = document.createElement('div');
  spine.className = 'dr-spine';
  spine.style.background = elementSpineCSS(entry.elements);
  row.appendChild(spine);

  const name = document.createElement('div');
  name.className = 'dr-name';
  name.textContent = entry.name;
  name.title = [entry.type, entry.rarity].filter(Boolean).join(' · ');
  row.appendChild(name);

  const qtyWrap = document.createElement('div');
  qtyWrap.className = 'dr-qty';
  const minus = document.createElement('button'); minus.textContent = '–'; minus.onclick = () => handlers.dec(entry.id);
  const num = document.createElement('span'); num.className = 'dr-qty-num'; num.textContent = entry.qty;
  const plus = document.createElement('button'); plus.textContent = '+'; plus.onclick = () => handlers.inc(entry.id);
  const del = document.createElement('button'); del.textContent = '×'; del.title = 'Remove'; del.onclick = () => handlers.remove(entry.id);
  qtyWrap.append(minus, num, plus, del);
  row.appendChild(qtyWrap);

  return row;
}

/* ---------------------------------------------------------------------- *
 * Export / import decks
 * ---------------------------------------------------------------------- */

function sanitizeFilename(name) {
  return (name || 'deck').replace(/[^a-z0-9\- _]/gi, '').trim().replace(/\s+/g, '-') || 'deck';
}

function deckToBulkText() {
  // Curiosa's bulk-add box is for the Atlas + Spellbook only — the Avatar
  // is picked separately, so it's left out here.
  const rows = deckEntryList()
    .filter((r) => r.type !== 'Avatar')
    .sort((a, b) => {
      const ao = TYPE_ORDER[a.type] ?? 2, bo = TYPE_ORDER[b.type] ?? 2;
      return ao - bo || a.name.localeCompare(b.name);
    });
  return rows.map((r) => `${r.qty} ${r.name}`).join('\n');
}

async function copyBulkList() {
  const text = deckToBulkText();
  if (!text) { toast('Your deck is empty — add some cards first.'); return; }
  window.grimoire.copyText(text);
  toast('Copied! Paste it into Curiosa\'s "bulk add" box.');
}

async function downloadBulkList() {
  const text = deckToBulkText();
  if (!text) { toast('Your deck is empty — add some cards first.'); return; }
  const res = await window.grimoire.exportBulkTxt(`${text}\n`, `${sanitizeFilename(deck.name)}-curiosa-bulk-add.txt`);
  if (res.ok) toast(`Saved to ${res.path}`);
  else if (!res.canceled) toast(`Save failed: ${res.error}`);
}

async function saveDeckJSON() {
  const payload = {
    format: 'grimoire-deck', version: 1,
    name: deck.name, deckFormat: deck.format,
    savedAt: new Date().toISOString(),
    entries: deck.entries,
    collection: deck.collection,
  };
  const res = await window.grimoire.saveDeckAs(payload, `${sanitizeFilename(deck.name)}.json`);
  if (res.ok) toast(`Saved to ${res.path}`);
  else if (!res.canceled) toast(`Save failed: ${res.error}`);
}

function applyDeckFileContent(raw) {
  // Try JSON first (a deck saved by this app)
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries) {
      deck.entries = parsed.entries;
      deck.collection = parsed.collection || {};
      deck.name = parsed.name || 'Loaded Deck';
      deck.format = parsed.deckFormat || parsed.format || deck.format;
      $('#deckName').value = deck.name;
      if ([...$('#deckFormat').options].some((o) => o.value === deck.format)) $('#deckFormat').value = deck.format;
      persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
      toast('Deck loaded.');
      return;
    }
  } catch (e) { /* not JSON — fall through to bulk-text parsing */ }

  // Fall back: parse "qty name" lines (Curiosa bulk-add format)
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const newEntries = {};
  let unmatched = 0;
  lines.forEach((line) => {
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) return;
    const qty = parseInt(m[1], 10);
    const name = m[2].trim();
    const card = state.db && state.db.cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (card) {
      newEntries[card.id] = { qty, name: card.name, type: card.type, elements: card.elements, cost: card.cost, rarity: card.rarity };
    } else {
      unmatched++;
      newEntries[slugify(name)] = { qty, name, type: '', elements: [], cost: null, rarity: '' };
    }
  });
  deck.entries = newEntries;
  deck.collection = {};
  persistDeck(); renderDeckPanel(); refreshGridQtyBadges();
  toast(unmatched ? `Deck loaded — ${unmatched} card name(s) weren't found in your database.` : 'Deck loaded.');
}

async function openDeckFile() {
  const res = await window.grimoire.openDeck();
  if (res.canceled) return;
  if (!res.ok) { toast(`Open failed: ${res.error}`); return; }
  applyDeckFileContent(res.content);
}

/* ---------------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------------- */

function wirePipGroup(containerId, datasetKey, filterSet) {
  $all(`#${containerId} .pip`).forEach((pip) => {
    pip.addEventListener('click', () => {
      const val = pip.dataset[datasetKey];
      if (filterSet.has(val)) { filterSet.delete(val); pip.classList.remove('active'); }
      else { filterSet.add(val); pip.classList.add('active'); }
      applyFiltersAndRender();
    });
  });
}

function wireDropZone(containerId, zone) {
  const el = $(`#${containerId}`);
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const { id, zone: fromZone } = JSON.parse(raw);
      moveEntryToZone(id, fromZone, zone);
    } catch (err) { /* malformed drag payload — ignore */ }
  });
}

function resetFilters() {
  state.filters.name = ''; $('#nameFilter').value = '';
  state.filters.text = ''; $('#textFilter').value = '';
  state.filters.artist = ''; $('#artistFilter').value = '';
  state.filters.subtype = ''; $('#subtypeFilter').value = '';
  state.filters.set = ''; $('#setFilter').value = '';
  state.filters.sort = 'name'; $('#sortFilter').value = 'name';

  [state.filters.types, state.filters.includeElements, state.filters.excludeElements, state.filters.rarities]
    .forEach((s) => s.clear());
  $all('#typeFilters .pip, #includeElementFilters .pip, #excludeElementFilters .pip, #rarityFilters .pip')
    .forEach((p) => p.classList.remove('active'));

  state.filters.numeric = emptyNumericFilters();
  $all('#numericFilters .numeric-row').forEach((row) => {
    row.querySelector('.input-op').value = '=';
    row.querySelector('.input-num').value = '';
  });

  applyFiltersAndRender();
}

function wireEvents() {
  buildNumericFilterUI();

  $('#nameFilter').addEventListener('input', debounce((e) => {
    state.filters.name = e.target.value; applyFiltersAndRender();
  }, 150));
  $('#textFilter').addEventListener('input', debounce((e) => {
    state.filters.text = e.target.value; applyFiltersAndRender();
  }, 150));
  $('#artistFilter').addEventListener('input', debounce((e) => {
    state.filters.artist = e.target.value; applyFiltersAndRender();
  }, 150));

  wirePipGroup('typeFilters', 'type', state.filters.types);
  wirePipGroup('includeElementFilters', 'el', state.filters.includeElements);
  wirePipGroup('excludeElementFilters', 'el', state.filters.excludeElements);
  wirePipGroup('rarityFilters', 'rarity', state.filters.rarities);

  $('#subtypeFilter').addEventListener('change', (e) => { state.filters.subtype = e.target.value; applyFiltersAndRender(); });
  $('#setFilter').addEventListener('change', (e) => { state.filters.set = e.target.value; applyFiltersAndRender(); });
  $('#sortFilter').addEventListener('change', (e) => { state.filters.sort = e.target.value; applyFiltersAndRender(); });
  $('#btnResetFilters').addEventListener('click', resetFilters);

  $('#deckName').addEventListener('input', () => { deck.name = $('#deckName').value; persistDeck(); });
  $('#deckFormat').addEventListener('change', () => { deck.format = $('#deckFormat').value; persistDeck(); });

  $('#btnHelp').addEventListener('click', () => window.grimoire.openHelp());
  $('#btnRefreshDb').addEventListener('click', () => refreshDbFromApi({ manual: true }));
  $('#btnImportDb').addEventListener('click', importDb);

  $('#btnCopyBulk').addEventListener('click', copyBulkList);
  $('#btnDownloadBulk').addEventListener('click', downloadBulkList);
  $('#btnSaveDeck').addEventListener('click', saveDeckJSON);
  $('#btnLoadDeck').addEventListener('click', openDeckFile);
  $('#btnClearDeck').addEventListener('click', clearDeck);
  $('#btnClearCollection').addEventListener('click', clearCollection);

  wireDropZone('deckList', 'deck');
  wireDropZone('collectionList', 'collection');

  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

/* ---------------------------------------------------------------------- *
 * Init
 * ---------------------------------------------------------------------- */

async function init() {
  wireEvents();
  await loadDeckFromStorage();
  renderDeckPanel();
  await loadImagesInfo();
  await initDb();
}

document.addEventListener('DOMContentLoaded', init);

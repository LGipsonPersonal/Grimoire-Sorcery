# Grimoire — desktop deck builder for Sorcery: Contested Realm

Grimoire is a small offline-first desktop app for building, editing, and
exporting decks for [Sorcery: Contested Realm](https://sorcerytcg.com). It
ships with a bundled card database, works entirely offline day-to-day, and
can refresh its card data from the official API with one click when you're
online.

It's built with [Electron](https://www.electronjs.org/) so it can be handed
to someone as a single double-clickable program — no browser, no server, no
account.

> **Unofficial fan project.** Grimoire is not affiliated with, endorsed by,
> or connected to Erik Olofsson, Curious Cabinet, or the official
> Sorcery: Contested Realm team. All card names, text, and imagery belong to
> their respective owners; this is just a tool built by a fan for the
> community.

## Contents

- [What it is (and isn't)](#what-it-is-and-isnt)
- [Limitations](#limitations)
- [Setting it up (development)](#setting-it-up-development)
- [Building an executable](#building-an-executable)
- [Using the app](#using-the-app)
- [Architecture](#architecture)
- [Modifying it](#modifying-it)
- [About card images](#about-card-images)
- [Card data / updates](#card-data--updates)
- [Contributing](#contributing)
- [License](#license)

## What it is (and isn't)

- It's a **deck builder**, not a card viewer for its own sake: the main
  workflows are searching/filtering the card pool, building a deck against
  Sorcery's rarity limits, and exporting that deck as a bulk-add list for
  [Curiosa](https://curiosa.io).
- It's **not connected to any account system**. Decks are plain files on
  your disk (native Save As / Open dialogs), plus one auto-saved
  "current deck" so you never lose in-progress work by closing the app.
- It has **no online multiplayer, deckbuilding legality server, or
  collection sync** — the "Collection" concept in the app (max 10 cards) is
  a local personal-collection tracker, not tied to anything external.

## Limitations

- **Rarity limits are a nudge, not enforced.** Ordinary ×4 / Exceptional ×3
  / Elite ×2 / Unique ×1 are shown and warned about, but you can exceed them
  — formats and errata change, so the app doesn't hard-block you.
- **Card data shape isn't guaranteed by Sorcery.** The public API
  (`api.sorcerytcg.com`) doesn't publish a formal schema and its own docs
  warn the response format can change without notice. `src/app.js` picks
  fields defensively (tries several plausible key names per attribute)
  rather than assuming one fixed shape, so a schema tweak degrades
  gracefully instead of breaking the app outright — but some fields may
  still show as blank until the parser is updated for a real change.
  Right-click any card in the app to see every raw field it detected.
- **Card art isn't bundled in this repository.** See
  [About card images](#about-card-images) below — you need to supply that
  folder yourself.
- **No auto-update.** This isn't distributed through an app store, so
  there's no built-in "check for new version of Grimoire" — only "check for
  new card data," which is a separate thing (the **Update** button).
- **Windows-first.** It's only been packaged/tested for Windows so far. The
  `package.json` build config also targets macOS and Linux, but building
  for those platforms means running `electron-builder` on a machine
  matching that OS (Electron apps generally aren't cross-compiled without
  extra tooling like Wine) — if you try one of those and hit issues,
  [issues](#contributing) are welcome.

## Setting it up (development)

You'll need [Node.js](https://nodejs.org) (any recent LTS).

```
npm install
```

Then add card art to `images/` (see [About card images](#about-card-images)
— it's not in the repo, you have to supply it yourself), and run:

```
npm start
```

This opens the app in a window immediately with no packaging — the fastest
way to check that data/images/UI changes look right.

## Building an executable

```
npm run dist         # build for whatever OS you're running this on
npm run dist:win      # Windows: portable .exe + NSIS installer
npm run dist:mac      # macOS: .dmg
npm run dist:linux    # Linux: AppImage + .deb
```

Output lands in `dist/`. For handing the app to someone else, the
**portable .exe** (Windows) is the simplest "no install, just run it"
option; the NSIS installer is a more familiar experience if they'd rather
have a proper Start Menu entry.

Note that `images/` gets bundled wholesale into the output, so build time
and the resulting file size scale directly with how much art you've put in
that folder — a full card-art set makes for a multi-gigabyte executable.

## Using the app

- **Help** (top-right of header) opens the in-app help guide — the one to
  point a non-technical user at instead of this README.
- **Update** (header) fetches the latest card list from the Sorcery API. If
  there's no internet it fails quietly with a toast, leaving your existing
  database untouched.
- **Import DB file…** — a native file dialog for loading a card database
  JSON file from disk (e.g. one someone else sent you), instead of fetching
  it from the API yourself.
- **Save as… / Open…** (deck) — native dialogs, real files, your choice of
  location.
- **Copy bulk-add list / Export for Curiosa (.txt)** — paste straight into
  Curiosa's "Show bulk add…" box. **Limitation:** this only includes the
  Atlas + Spellbook portion of the deck — Curiosa's bulk-add feature doesn't
  support adding Avatars or Collection cards, so you'll set the Avatar
  manually on Curiosa after pasting.
- Your in-progress deck auto-saves as you work, so closing and reopening
  the app won't lose anything even without an explicit save.

## Architecture

Grimoire follows Electron's standard three-piece split, which exists mainly
so the UI (untrusted-ish web code) never gets direct filesystem/network
access — it has to go through a narrow, explicit bridge.

```
┌─────────────────┐      IPC       ┌──────────────────┐
│  src/ (renderer) │ ─────────────▶ │   preload.js      │
│  index.html      │ ◀───────────── │  (context bridge)  │
│  style.css       │                └──────────┬─────────┘
│  app.js          │                           │ ipcMain.handle(...)
└─────────────────┘                           ▼
                                     ┌──────────────────┐
                                     │     main.js        │
                                     │  (Node, Electron    │
                                     │   main process)     │
                                     └──────────┬─────────┘
                                                │
                        ┌───────────────────────┼───────────────────────┐
                        ▼                       ▼                       ▼
              data/*.json (bundled)    images/ (bundled)      api.sorcerytcg.com
              → seeds per-user DB      → scanned & served      (live card fetch)
              in userData on first run   as file:// URLs
```

- **`main.js`** — the Electron main process (plain Node). Owns:
  - the card database: seeds a writable copy from `data/sorcery-card-database.json`
    into the OS-level per-app userData folder on first run, then reads/writes
    that copy from then on (so updating the DB never touches files inside the
    installed app itself);
  - talking to the Sorcery API (`https://api.sorcerytcg.com/api/cards`) —
    this happens in Node specifically because CORS blocks a *browser* page
    from calling that API directly, and Node isn't a browser, so that
    restriction doesn't apply here;
  - scanning `images/` and handing back a `file://` base URL + file list;
  - native dialogs for import/save/open;
  - opening the in-app **Help** window (a second, unprivileged `BrowserWindow`
    with no preload/Node access, since it only ever shows static content).
- **`preload.js`** — runs with special privileged access but exposes only a
  small, explicit `window.grimoire` API to the page (`contextIsolation: true`,
  `nodeIntegration: false`). The renderer can't reach Node or the filesystem
  except through these named methods.
- **`src/`** — the actual UI, plain HTML/CSS/JS (no framework/build step):
  - `index.html` — layout/markup
  - `style.css` — styling
  - `app.js` — everything else: card normalization, filtering/sorting,
    deck state, image matching, rendering, all UI wiring. Single file,
    ~1200 lines, organized top-to-bottom by concern (see the section
    comments inside it).
  - `help.html` — the standalone, non-technical help guide shown in its own
    window (see [The Help window](#the-help-window) below). Reuses
    `style.css` for a consistent look but has no script of its own — it's
    static content, opened by `main.js` rather than linked to directly.
- **`data/sorcery-card-database.json`** — the bundled *default* card list,
  used only to seed a machine on first run. The database that's actually
  read/written after that lives outside the project, in the user's app data
  folder.
- **`images/`** — card art, matched to cards by filename at runtime (see
  below). Not committed to this repo.
- **`build/`** — app icons (`icon.ico` / `icon.png`).
- **`package.json`** — dependencies plus the `electron-builder` config
  (`build` key) that controls what gets packaged and how.

### Card → image matching

Images aren't referenced by ID anywhere in the database. Instead, at
runtime `app.js` builds a set of candidate filenames per card (from its
printing/variant slugs and its name, slugified, across `.png/.jpg/.jpeg/.webp`)
and checks each candidate against whatever files actually exist in
`images/`. This means:

- Partial art coverage is fine — cards with no matching file just render as
  text-only tiles, nothing breaks.
- Dropping more files into `images/` and relaunching (or just re-scanning,
  since it rescans the folder fresh on load) is all that's needed to add
  art incrementally — no code change, no rebuild in dev mode.

### The Help window

The **Help** button (top-right of the header) calls `window.grimoire.openHelp()`,
which asks `main.js` to open (or refocus, if already open) a second
`BrowserWindow` loading `src/help.html`. It's written in plain language for
someone with no technical background — what the app does, how to search
and build a deck, saving/exporting, updating card data, and troubleshooting.
It's a separate static page rather than a modal because it's meant to stay
open for reference alongside the main window, and it deliberately gets no
preload script, since it never needs anything beyond rendering its own
content.

## Modifying it

- **UI/behavior changes** — edit `src/app.js` / `index.html` / `style.css`,
  then `npm start` to reload. No build step for the renderer code.
- **Changing what card fields are read from the API**, or how images are
  matched to cards — look at `normalizeRawCard()` and
  `candidateImageFilenames()` in `src/app.js`.
- **Changing what's persisted or how dialogs behave** — that's all in
  `main.js` (the `ipcMain.handle(...)` blocks) plus the matching method in
  `preload.js`. Any new capability the UI needs from the OS has to be added
  in both places: a handler in `main.js` and a matching exposed method in
  `preload.js` — the renderer has no other way to reach the filesystem.
- **Changing what a non-technical user is told** — update `src/help.html`
  (see [The Help window](#the-help-window)) alongside any UI change worth
  explaining. It isn't generated from this README or vice versa, so the two
  can drift if only one gets updated.
- **Changing what ships in the built app** — the `build` key in
  `package.json` (`files`, `extraResources`, per-OS `target`s, icons).

## About card images

Card art is **not included in this repository** — it's excluded via
`.gitignore`, since a few thousand PNGs (several GB) don't belong in git
history.

To get art:

1. Download the image set from: **https://drive.google.com/drive/folders/17IrJkRGmIU9fDSTU2JQEU9JlFzb5liLJ**
2. Extract/copy the files directly into the `images/` folder at the project
   root (flat, no subfolders).
3. `npm start` (or a fresh `npm run dist` build) will pick them up
   automatically — see [Card → image matching](#card--image-matching) for
   how filenames need to line up with cards.

## Card data / updates

The bundled database in `data/sorcery-card-database.json` is a point-in-time
snapshot. For the live, current card list and any format/API notes, see the
official Sorcery API: **https://api.sorcerytcg.com/**.

In the app itself, click **Update** to pull the latest data directly — no
need to manually replace `data/sorcery-card-database.json` (that file is
only ever used to seed a brand-new install; after that, the app's own copy
in its userData folder is what's live).

## Contributing

Issues and pull requests are welcome — there's no formal process yet, so a
short description of what changed and why is plenty. If you're touching
`main.js` or `preload.js`, see [Modifying it](#modifying-it) for the pattern
new IPC-exposed capabilities should follow.

## License

[MIT](LICENSE).

// Monday.com, read-only for now: pull the boards the token can see and keep
// the last pull on disk, so the tab has something to show without calling
// out every time you open it.
import express from 'express';
import { read, write, DEFAULT_SETTINGS } from './store.js';
import * as google from './google.js';

const API = process.env.MONDAY_API_URL || 'https://api.monday.com/v2';
// Pin the API version: Monday moves the default forward and fields come and
// go with it. Bump this deliberately, not by surprise.
const API_VERSION = '2024-10';
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5,000 boards is far past "a list of boards"

const settings = () => ({ ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) });

export function tokenSet() {
  return !!settings().mondayToken;
}

function tokenOrThrow() {
  const token = settings().mondayToken;
  if (!token) throw new Error('No Monday.com token. Add a personal access token on the Settings tab.');
  return token;
}

/**
 * One GraphQL call. Monday answers 200 with an `errors` array for things
 * like a bad field or a revoked token, so a status check alone is not enough.
 */
async function graphql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: tokenOrThrow(),
      'api-version': API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Monday.com returned ${res.status} ${res.statusText}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('Monday.com rejected the token. Check it on the Settings tab.');
  }
  if (res.status === 429) {
    throw new Error('Monday.com is rate-limiting this token. Wait a minute and refresh again.');
  }
  const errors = body.errors || body.error_message;
  if (errors) {
    const first = Array.isArray(errors) ? errors[0]?.message : errors;
    throw new Error(`Monday.com: ${first || 'request failed'}`);
  }
  if (!res.ok) throw new Error(`Monday.com returned ${res.status} ${res.statusText}`);
  return body.data;
}

const BOARDS_QUERY = `
  query ($limit: Int!, $page: Int!) {
    boards(limit: $limit, page: $page, order_by: created_at) {
      id
      name
      description
      state
      board_kind
      url
      items_count
      updated_at
      workspace { id name }
      owners { id name }
    }
  }
`;

const ME_QUERY = `query { me { id name email account { id name slug } } }`;

// Items come back a page at a time behind a cursor, and the columns are
// described once for the whole board rather than per item.
const ITEMS_QUERY = `
  query ($ids: [ID!], $limit: Int!, $cursor: String) {
    boards(ids: $ids) {
      id
      name
      url
      columns { id title type }
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          updated_at
          group { id title }
          column_values { id text type }
        }
      }
    }
  }
`;

const ITEM_PAGE = 250;
const MAX_ITEM_PAGES = 200; // 50,000 rows

/** Every row of one board, flattened to { id, name, group, cells: {colId: text} }. */
export async function fetchItems(boardId) {
  let cursor = null;
  let board = null;
  const items = [];
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const data = await graphql(ITEMS_QUERY, { ids: [String(boardId)], limit: ITEM_PAGE, cursor });
    const b = data?.boards?.[0];
    if (!b) throw new Error('That board is not there any more — pull the board list again.');
    board = board || {
      id: String(b.id),
      name: b.name,
      url: b.url || `https://monday.com/boards/${b.id}`,
      columns: (b.columns || []).map(shapeColumn),
    };
    for (const it of b.items_page?.items || []) items.push(shapeItem(it));
    cursor = b.items_page?.cursor || null;
    if (!cursor) break;
  }
  return { ...board, items, fetchedAt: new Date().toISOString() };
}

const shapeColumn = (c) => ({ id: c.id, title: c.title || c.id, type: c.type || '' });

const shapeItem = (it) => ({
  id: String(it.id),
  name: it.name || '',
  group: it.group?.title || '',
  updatedAt: it.updated_at || '',
  // `text` is the rendered value — the same string the board shows.
  cells: Object.fromEntries((it.column_values || []).map((cv) => [cv.id, cv.text ?? ''])),
});

const itemsFile = (boardId) => `monday-boards/${String(boardId).replace(/[^A-Za-z0-9_-]/g, '')}`;

export const cachedItems = (boardId) => read(itemsFile(boardId), null);

export async function refreshItems(boardId) {
  return write(itemsFile(boardId), await fetchItems(boardId));
}

// ------------------------------------------------- syncing a board to Sheets

/** Where each board was last synced: board id → { url, … }. */
const syncTargets = () => read('monday-sync', {});

export function syncTarget(boardId) {
  return syncTargets()[String(boardId)] || null;
}

function rememberTarget(boardId, target) {
  const all = syncTargets();
  all[String(boardId)] = target;
  write('monday-sync', all);
  return target;
}

/** The board as a grid: a header row, then one row per item. */
export function toGrid(board) {
  const header = ['Item ID', 'Name', 'Group', ...board.columns.map((c) => c.title), 'Last updated'];
  const rows = board.items.map((it) => [
    it.id,
    it.name,
    it.group,
    ...board.columns.map((c) => it.cells[c.id] ?? ''),
    it.updatedAt,
  ]);
  return [header, ...rows];
}

/**
 * Pull the board fresh and replace the sheet's contents with it. Fresh
 * deliberately: "sync" should never write yesterday's rows.
 */
export async function syncToSheet(boardId, url) {
  const parsed = google.parseSheetUrl(url);
  const board = await refreshItems(boardId);
  const written = await google.overwriteSheet({ ...parsed, rows: toGrid(board) });
  const target = rememberTarget(boardId, {
    url: parsed.url,
    spreadsheetId: parsed.spreadsheetId,
    gid: parsed.gid,
    tab: written.tab,
    file: written.file,
    lastSyncedAt: new Date().toISOString(),
    rows: board.items.length,
  });
  return { ...written, target, board };
}

/** Every board the token can see, oldest first, one page of 100 at a time. */
export async function fetchBoards() {
  const boards = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await graphql(BOARDS_QUERY, { limit: PAGE_SIZE, page });
    const batch = data?.boards || [];
    boards.push(...batch.map(shape));
    if (batch.length < PAGE_SIZE) break;
  }
  return boards;
}

/** Keep the shape flat and stable — the UI should not care about GraphQL. */
const shape = (b) => ({
  id: String(b.id),
  name: b.name || '(untitled board)',
  description: b.description || '',
  state: b.state || '',
  kind: b.board_kind || '',
  url: b.url || `https://monday.com/boards/${b.id}`,
  items: b.items_count ?? null,
  updatedAt: b.updated_at || '',
  workspace: b.workspace?.name || '',
  owners: (b.owners || []).map((o) => o.name).filter(Boolean),
});

export async function whoami() {
  const data = await graphql(ME_QUERY);
  const me = data?.me;
  return me ? { name: me.name, email: me.email, account: me.account?.name || '' } : null;
}

/** The last pull, as stored. */
export const cached = () => read('monday', { boards: [], fetchedAt: null, account: null });

/**
 * Which boards you starred. Kept in their own file so a refresh — which
 * replaces the whole cache — cannot lose them, and so a board that
 * disappears from Monday and comes back is still a favorite.
 */
export const favorites = () => read('monday-favorites', []).map(String);

export function setFavorite(id, on) {
  const ids = favorites().filter((x) => x !== String(id));
  if (on) ids.push(String(id));
  return write('monday-favorites', ids);
}

/** Pull boards live and remember them. Favorites are untouched. */
export async function refresh() {
  const [account, boards] = [await whoami(), await fetchBoards()];
  return write('monday', { boards, account, fetchedAt: new Date().toISOString() });
}

// ------------------------------------------------------------------ routes

export const mondayRoutes = express.Router();

const fail = (res, err) => res.status(err.status || 400).json({ error: err.message });

mondayRoutes.get('/status', (_req, res) => {
  const c = cached();
  res.json({
    tokenSet: tokenSet(),
    fetchedAt: c.fetchedAt,
    account: c.account,
    boardCount: c.boards.length,
    favorites: favorites(),
  });
});

// What we already have. Opening the tab costs nothing.
mondayRoutes.get('/boards', (_req, res) => {
  res.json({ ...cached(), tokenSet: tokenSet(), favorites: favorites() });
});

// Go and ask Monday.com.
mondayRoutes.post('/boards/refresh', async (_req, res) => {
  try {
    res.json({ ...(await refresh()), tokenSet: true, favorites: favorites() });
  } catch (err) {
    fail(res, err);
  }
});

// The rows of one board. Cached, so coming back to a board is instant.
mondayRoutes.get('/boards/:id/items', (req, res) => {
  const cache = cachedItems(req.params.id);
  res.json({ ...(cache || { items: [], columns: [], fetchedAt: null }), tokenSet: tokenSet(), sync: syncTarget(req.params.id) });
});

mondayRoutes.post('/boards/:id/items/refresh', async (req, res) => {
  try {
    res.json({ ...(await refreshItems(req.params.id)), tokenSet: true, sync: syncTarget(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

// Overwrite a Google Sheet with this board, as it stands right now.
mondayRoutes.post('/boards/:id/sync', async (req, res) => {
  try {
    const url = req.body?.url || syncTarget(req.params.id)?.url;
    res.json(await syncToSheet(req.params.id, url));
  } catch (err) {
    fail(res, err);
  }
});

// Star or unstar one board. The id need not be in the cache — you can star a
// board and refresh later.
mondayRoutes.put('/boards/:id/favorite', (req, res) => {
  try {
    res.json({ favorites: setFavorite(req.params.id, !!req.body?.favorite) });
  } catch (err) {
    fail(res, err);
  }
});

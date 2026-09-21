// Monday.com, read-only for now: pull the boards the token can see and keep
// the last pull on disk, so the tab has something to show without calling
// out every time you open it.
import express from 'express';
import { read, write, DEFAULT_SETTINGS } from './store.js';

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

/** Pull boards live and remember them. */
export async function refresh() {
  const [account, boards] = [await whoami(), await fetchBoards()];
  return write('monday', { boards, account, fetchedAt: new Date().toISOString() });
}

// ------------------------------------------------------------------ routes

export const mondayRoutes = express.Router();

const fail = (res, err) => res.status(err.status || 400).json({ error: err.message });

mondayRoutes.get('/status', (_req, res) => {
  const c = cached();
  res.json({ tokenSet: tokenSet(), fetchedAt: c.fetchedAt, account: c.account, boardCount: c.boards.length });
});

// What we already have. Opening the tab costs nothing.
mondayRoutes.get('/boards', (_req, res) => {
  res.json({ ...cached(), tokenSet: tokenSet() });
});

// Go and ask Monday.com.
mondayRoutes.post('/boards/refresh', async (_req, res) => {
  try {
    res.json({ ...(await refresh()), tokenSet: true });
  } catch (err) {
    fail(res, err);
  }
});

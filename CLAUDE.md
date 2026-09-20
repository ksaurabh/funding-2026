# Working in this repo

## Never kill processes by a broad pattern

The user runs this app in the background, often from a *different checkout* of
this same repo (e.g. `../funding-2026-working-space`). A pattern kill like

```bash
pkill -f "server/index.js"      # NO
pkill -f "node server"          # NO
pkill -f node                   # NO
```

matches their server too and takes it down mid-run, losing whatever research
was in flight. This has already happened once.

Kill only what you started, by pid or by port:

```bash
# you started it and kept the pid
kill "$SERVER_PID"

# or target the port you chose
lsof -ti tcp:4123 | xargs -r kill
```

Pick an unusual port for your own test servers (4123, 4999 — not 4000) so you
never contend with theirs, and stop them by port when you are done.

`./run.sh stop` is the right way to stop a server started by `./run.sh`.

## Never test destructive endpoints against the user's real lists

`POST /api/lists/:id/reimport` replaces a list's rows, and re-importing a
different CSV over a list silently drops columns. Create a throwaway list
first and point destructive tests at that. This has already cost the user's
main list once (recovered from `data/investors.json.migrated`).

## Verify after a slice edit to public/app.js

Replacing a span of that file between two function-name anchors has
silently deleted the functions that happened to sit in between —
`renderTable`, `rangeSelect` and `editableCell` were all lost this way in
one edit, and the page died with "renderTable is not defined". `node
--check` does not catch it, because the file is still valid JavaScript.

After any such edit, check that every function called is still defined,
and that every `$('#id')` the script binds exists in the HTML. Prefer
targeted `Edit` calls over slicing between anchors.

## The LinkedIn agent drives a real browser

`server/linkedin/` opens the user's actual Chrome with their signed-in
LinkedIn session. Do not test it against linkedin.com — starting a session
opens a window on their machine, and automated traffic risks their account
being rate-limited or blocked. Point `LINKEDIN_BASE` at a local stand-in
instead; there is a fixture pattern in the git history of this feature.

Selectors live only in `server/linkedin/selectors.js`, and people are read
structurally in `server/linkedin/extract.js`. When lookups come back empty or
wrong, replay the saved page with `node tools/parse-saved.mjs` and fix against
that, rather than guessing at markup.

Read rendered text, never raw text. `page.textContent()` and `.innerHTML`
include nodes the browser does not display: a real profile page carries an
unrendered `· 1st` ahead of the visible `· 2nd`, so a scan of raw text
reported a second-degree contact as first-degree. Use `innerText`, and take a
value from the element it belongs to — a profile lists a dozen other people's
degrees further down the page.

## Their data lives in `data/` and is gitignored

`data/` holds the API key, the imported lists, manual cell edits and every
answer. Never stage it, never delete it, and check `git diff --cached` before
committing. Files ending `.migrated.json` are backups from schema changes —
leave them alone.

## Testing the model path without a key

There is no `ANTHROPIC_API_KEY` on this machine. To exercise the runner
end to end, point the SDK at a local stub with `ANTHROPIC_BASE_URL` and set a
placeholder key in `data/settings.json`; a stub only needs to answer
`POST /v1/messages` with a `content: [{type: "text", ...}]` message. Remember
to clear the placeholder key afterwards.

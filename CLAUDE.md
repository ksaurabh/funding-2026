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

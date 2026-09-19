# Investor Playbook

A small local app for CSV-driven research. Import one or more CSV lists, give
each list a playbook of LLM questions, run it over every row, and browse the
answers.

```bash
npm install
npm start          # http://localhost:4000   (PORT=xxxx to change)
```

## How it works

### Lists

The home page is a set of **lists**. Each list is one imported CSV with its own
playbook and its own answers, so you can research VC firms with one set of
questions and, say, funding rounds with another. **Import CSV list** creates a
new one; cards show row count, playbook size, how many rows are fully
researched, and when the list last ran. From a card you can open it, jump
straight to its playbook, export it, rename it or delete it.

On first boot the app seeds one list from `funding-round-investors.csv` sitting
next to it, with three sample steps. (If you used the earlier single-list
version, that data is migrated into a list automatically on startup.)

### Settings

Global, shared by every list: an Anthropic API key (stored in
`data/settings.json`, which is gitignored), model, effort level, max tokens per
answer, and how many rows to process in parallel. If `ANTHROPIC_API_KEY` is set
in the environment the first boot picks it up automatically.

### Playbook (per list)

An ordered list of *ask an LLM* steps. Each step has a name, a prompt, and a
"let the model search the web" toggle (Anthropic's server-side web search --
sources are captured and shown with the answer). Prompts are templates:

| Token | Fills in with |
|---|---|
| `{{Lead Investor}}`, `{{Deals}}`, ... | the matching column from the CSV row (names are case-insensitive) |
| `{{steps.thesis}}` | the answer an earlier step in the same run produced |

The right-hand pane lists every token available *for this list* (click one to
insert it) and live-previews the rendered prompt against a real row.

*Step context* controls how steps relate: **Conversation** (default) runs the
whole playbook as one thread, so step 3 already sees the answers to steps 1
and 2; **Independent** sends each step as a fresh call.

**Copy playbook from...** clones another list's steps into this one -- handy
when two lists share column names.

### Researching a list

The list view is the CSV as a table, with an `answers` badge per row showing how
many enabled steps have run. Click a row to read every answer, its sources, and
the exact prompt that produced it. From there you can re-run the whole playbook
for that one row, or re-run a single step.

Across the whole list: **Run all**, or **Run unanswered** to fill in only the
gaps (useful after adding a step, or after a partial run). A run streams
progress into the log strip at the bottom and can be cancelled mid-flight.
Answers are written to disk after every step, so nothing is lost if you stop.
One run happens at a time across the whole app.

**Export CSV** gives you that list's original columns plus one column per step.

## Layout

```
server/
  index.js    HTTP API + static hosting
  runner.js   template rendering, job queue, per-step persistence
  llm.js      Anthropic call (adaptive thinking, effort, web search, pause_turn)
  csv.js      RFC-4180 parse/serialize
  store.js    atomic JSON file store
public/       single-page UI, hash-routed, no build step
data/                          (gitignored)
  settings.json                global
  lists.json                   the list index
  lists/<id>/investors.json    rows
  lists/<id>/playbook.json     steps
  lists/<id>/answers.json      answers
```

## Cost note

A run is `rows × enabled steps` API calls. The bundled list has 529 rows, so a
3-step playbook over all of it is ~1,600 Opus calls. Try a single row first,
then scale up — or switch the model to Sonnet 5 or
Haiku 4.5 on the Settings page.

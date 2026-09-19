# Investor Playbook

A small local app for CSV-driven research. Import one or more CSV lists, give
each list a playbook of LLM questions, run it over every row, and browse the
answers.

```bash
./run.sh start              # installs deps if needed, then serves on :4000
./run.sh start --port 4100  # any other port
./run.sh status
./run.sh logs -f
./run.sh stop
```

`run.sh start` detaches the server: it keeps running after you close the
terminal, and its command line carries `--instance=<name>` so it is easy to
tell apart from a foreground dev server. State (pid, port, log) lives in
`.run/`, which is gitignored.

For a foreground server instead — logs in your terminal, Ctrl-C to stop:

```bash
npm install
npm start          # http://localhost:4000   (PORT=xxxx to change)
npm run dev        # same, restarting on file changes
```

To run two copies at once, use **two checkouts**. Each directory has its own
`data/`, so they stay independent; two servers in one directory would write the
same files and corrupt them (`run.sh` warns if you try).

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

### Columns (per list)

**Columns…** on a list's toolbar controls how the list behaves as a table.
Imported columns are **shown but read-only** — they are the data you brought
in. Per column you can:

- Set what it is: **Read-only** (the default for imported columns), **Free
  text**, or **Dropdown**. Only an editable column can be typed into or filled
  in by a playbook step.
- Give a dropdown its **choices**, seeded from the values already in that
  column; you can add or remove them, and picking a value that isn't in the
  list yet adds it. (Columns with more than 200 distinct values are too
  free-text for this.) Choices are kept if you switch back to read-only, so
  the round trip is lossless.
- **Rename** it. The imported rows, your cell values and the column settings
  all move with it, and playbook steps belonging only to this list have their
  `{{Old Name}}` tokens and fill targets updated. A playbook shared with
  another list is left alone and reported, rather than rewritten behind your
  back.
- **Show or hide** it in the table. The first four imported columns show by
  default; everything else is available but out of the way.
- **Add** a column of your own, free text or dropdown. Added columns are
  editable from the start.

Cell values are stored separately from the imported rows, so `investors.json`
stays exactly as imported and a re-import keeps your values for every row that
survives it.

### Narrowing and picking rows

A collapsible filter bar sits above the table, one column per row. **Answers**
filters by how far each row has got — *Not started*, *Partial*, *Complete*,
*Has errors* — and each dropdown column you have put on the bar adds a row of
its values, with counts and a `(blank)` bucket. Several chips in one row widen
the match; chips in different rows narrow it. The search box filters on any
column's text.

You choose what is worth filtering by. Filtering only reads, so **any** column
can go on the bar — it does not have to be editable or a dropdown. Tick
**Filter** next to a column in **Columns…**, or use **+ Add filter** on the bar
itself; **×** on a row takes it off again (and stops it narrowing the list).
Dropdown columns start on the bar, everything else starts off it, and columns
with more than 60 distinct values are not offered. The choice is saved with the
list. Collapsed, the bar still names what is currently narrowing the list, and
remembers being collapsed.

Rows also have **tick boxes**. Tick any set of rows — shift-click to take a
span, the header box takes everything currently on screen — and the run
buttons switch to that set. A selection survives changing the filter, since
you picked those rows deliberately; **Clear selection** drops it.

### Playbooks

A playbook is **saved once, named, and attached to any number of lists** — the
**Playbooks** page lists them all with the lists using each one, and lets you
duplicate, rename or delete. A list's **Playbook** tab picks which one it uses
and edits it in place, with the tokens and preview of that list for context.

Editing a shared playbook changes it for every list using it; the tab says so
when that is the case, and **Save as new…** branches off a private copy
instead. A duplicate gets fresh step ids, so its answers stay separate from the
original's.

A playbook is an ordered list of *ask an LLM* steps. Each step has a name, a
prompt, a "let the model search the web" toggle (Anthropic's server-side web
search — sources are captured and shown with the answer), and optionally a
column to **fill in** from its answer. Prompts are templates:

| Token | Fills in with |
|---|---|
| `{{Lead Investor}}`, `{{Deals}}`, … | the matching column from the row, including edited and added columns (names are case-insensitive) |
| `{{steps.thesis}}` | the answer an earlier step in the same run produced |

The right-hand pane lists every token available *for this list* (click one to
insert it) and live-previews the rendered prompt against a real row.

*Step context* controls how steps relate: **Conversation** (default) runs the
whole playbook as one thread, so step 3 already sees the answers to steps 1
and 2; **Independent** sends each step as a fresh call.

**Fill column** wires a step's answer into one of the list's editable columns:

- a **free text** column gets the answer verbatim;
- a **dropdown** column gets exactly one of its allowed values. A short
  follow-up call constrained by a JSON schema (`output_config.format`) picks
  it, so the model cannot return anything outside the list — it costs one
  extra small call per row, and only for dropdown columns.

The answer is kept in full either way, so the column holds the verdict and the
row detail still shows the reasoning behind it. Reusing a playbook on a list
that lacks a column it fills is not an error: those steps still run, and the
row notes that the column is missing.

### What it costs

Every call's token usage is priced as it happens, at the published rate for the
model that made it, and stored with the answer. The header shows the **running
total across all lists**; each list card and the list toolbar show that list's
share; the run pill counts up live; and each answer shows its own cost and
token counts. **Run all** projects the bill from what that list has actually
averaged per row, when it has been run before.

Prices live in `server/pricing.js` — update them there if Anthropic's change.
Costs already recorded keep the figure they were computed with, and a model
with no price on file shows the total as a floor (`$1.23+`) rather than
silently undercounting.

### Researching a list

The list view is the CSV as a table, with an `answers` badge per row showing how
many enabled steps have run. Click a row to read every answer — rendered as Markdown, so headings,
lists, tables, code and links come out formatted — along with its sources and
its cost.

**What was sent** under each answer opens the whole request: the system prompt,
every message in the thread (in conversation mode that includes the earlier
steps replayed with it), and every web search the model ran while answering,
with the queries and the pages it read. It also apportions the input tokens,
which is usually the answer to "why did this step cost so much" — search
results are billed as input even though they never appear in the prompt you
wrote. Nothing extra is stored for this: the thread is reassembled from the
prompts and answers already on record. From there you can re-run the whole playbook
for that one row, or re-run a single step.

The two run buttons always say what they will actually do:

- **Run all 529** — every row, when nothing is ticked or filtered.
- **Run 12 selected** — the ticked rows, wherever they sit in the list.
- **Run 37 filtered** — the rows the filters have left on screen, when nothing
  is ticked. Either way the set is fixed when you click, so rows still run if
  the playbook changes a value they were filtered on.
- **Run unanswered (n)** — only rows missing answers, narrowed to whichever of
  those sets is in play. Useful after adding a step, or after a partial run.

Both confirm first, projecting the bill from this list's own average per row.
A run streams progress into the log strip at the bottom and can be cancelled
mid-flight. Answers are written to disk after every step, so nothing is lost if
you stop. One run happens at a time across the whole app.

**Download CSV** gives you the whole list -- imported columns, your edits, and
the columns the playbook filled in -- plus one `<step name> (answer)` column
holding each step's full answer.

## Layout

```
run.sh        start/stop/status/logs for a detached server
server/
  index.js    HTTP API + static hosting
  serve.js    entry point used by run.sh
  pricing.js  per-model token prices
  runner.js   template rendering, job queue, per-step persistence
  llm.js      Anthropic call (adaptive thinking, effort, web search, pause_turn)
  csv.js      RFC-4180 parse/serialize
  store.js    atomic JSON file store
public/       single-page UI, hash-routed, no build step
  markdown.js small Markdown renderer; builds DOM nodes, never innerHTML
data/                          (gitignored)
  settings.json                global
  lists.json                   the list index
  lists/<id>/investors.json    rows, exactly as imported
  lists/<id>/edits.json        cell values you or a step wrote
  lists/<id>/schema.json       editable and added columns
  lists/<id>/answers.json      answers, with per-step cost
  playbooks.json               the playbook index
  playbooks/<id>.json          one reusable playbook
```

## Before you run the whole thing

A run is `rows × enabled steps` API calls, plus one small extra call per step
that fills a dropdown column. A 529-row list with a 3-step playbook is ~1,600
Opus calls. Run a single row first, read what it cost in the header, then
decide — or switch to Sonnet 5 or Haiku 4.5 on the Settings page.

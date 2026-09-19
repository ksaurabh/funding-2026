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

### Columns (per list)

**Editable columns…** on a list's toolbar turns the CSV into something you can
work in, not just read:

- **A column from the CSV** can be made into a **dropdown**. Its choices start
  as the distinct values already in that column, and you can add or remove
  choices. (Columns with more than 200 distinct values are too free-text to
  offer as a dropdown.)
- **You can add new columns**, either **free text** or a **dropdown** with the
  values you list.

Edited cells are stored separately from the imported rows, so `investors.json`
stays exactly as imported and a re-import keeps your values for every row that
survives it. Picking a value that isn't in a dropdown yet adds it to the list.

Every dropdown column also becomes a **filter** above the table: click values to
narrow the list, with counts and a `(blank)` bucket. Several values in one
column widen the match; values in different columns narrow it.

### Playbook (per list)

An ordered list of *ask an LLM* steps. Each step has a name, a prompt, a
"let the model search the web" toggle (Anthropic's server-side web search --
sources are captured and shown with the answer), and optionally a column to
**fill in** from its answer. Prompts are templates:

| Token | Fills in with |
|---|---|
| `{{Lead Investor}}`, `{{Deals}}`, ... | the matching column from the row, including edited and added columns (names are case-insensitive) |
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
  it, so the model cannot return anything outside the list -- it costs one
  extra small call per row, and only for dropdown columns.

The answer is kept in full either way, so the column holds the verdict and the
row detail still shows the reasoning behind it.

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

**Download CSV** gives you the whole list -- imported columns, your edits, and
the columns the playbook filled in -- plus one `<step name> (answer)` column
holding each step's full answer.

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
  lists/<id>/investors.json    rows, exactly as imported
  lists/<id>/edits.json        cell values you or a step wrote
  lists/<id>/schema.json       editable and added columns
  lists/<id>/playbook.json     steps
  lists/<id>/answers.json      answers
```

## Cost note

A run is `rows × enabled steps` API calls, plus one small extra call per step
that fills a dropdown column. The bundled list has 529 rows, so a
3-step playbook over all of it is ~1,600 Opus calls. Try a single row first,
then scale up — or switch the model to Sonnet 5 or
Haiku 4.5 on the Settings page.

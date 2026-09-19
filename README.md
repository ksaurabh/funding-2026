# Investor Playbook

A small local app that runs an LLM "playbook" against every investor in a CSV
and lets you browse the answers.

```bash
npm install
npm start          # http://localhost:4000   (PORT=xxxx to change)
```

On first boot it seeds the investor list from `funding-round-investors.csv`
sitting next to the app. You can replace it any time with **Import CSV**.

## How it works

**Settings** — paste an Anthropic API key (stored in `data/settings.json`, which
is gitignored), pick a model, effort level, max tokens per answer, and how many
investors to process in parallel. If `ANTHROPIC_API_KEY` is set in the
environment the first boot picks it up automatically.

**Playbook** — an ordered list of *ask an LLM* steps. Each step has a name, a
prompt, and a "let the model search the web" toggle (Anthropic's server-side
web search — sources are captured and shown with the answer). Prompts are
templates:

| Token | Fills in with |
|---|---|
| `{{Lead Investor}}`, `{{Deals}}`, … | the matching column from the CSV row (names are case-insensitive) |
| `{{steps.thesis}}` | the answer an earlier step in the same run produced |

The right-hand pane lists every available token (click one to insert it) and
live-previews the rendered prompt against a real row.

*Step context* controls how steps relate: **Conversation** (default) runs the
whole playbook as one thread, so step 3 already sees the answers to steps 1
and 2; **Independent** sends each step as a fresh call.

**Investors** — the CSV as a table, with an `answers` badge per row showing how
many enabled steps have run. Click a row to read every answer, its sources,
and the exact prompt that produced it. From there you can re-run the whole
playbook for that one investor, or re-run a single step.

Across the whole list: **Run all**, or **Run unanswered** to fill in only the
gaps (useful after adding a step, or after a partial run). A run streams
progress into the log strip at the bottom and can be cancelled mid-flight.
Answers are written to disk after every step, so nothing is lost if you stop.

**Export CSV** gives you the original columns plus one column per step.

## Layout

```
server/
  index.js    HTTP API + static hosting
  runner.js   template rendering, job queue, per-step persistence
  llm.js      Anthropic call (adaptive thinking, effort, web search, pause_turn)
  csv.js      RFC-4180 parse/serialize
  store.js    atomic JSON file store
public/       single-page UI (no build step)
data/         settings, playbook, investors, answers  (gitignored)
```

## Cost note

A run is `investors × enabled steps` API calls. The bundled list has 529
investors, so a 3-step playbook on the full list is ~1,600 Opus calls. Try a
single investor first, then scale up — or switch the model to Sonnet 5 or
Haiku 4.5 on the Settings page.

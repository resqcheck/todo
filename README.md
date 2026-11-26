# To-Do List — iteration 1

A to-do list that runs in a browser with no build step, no framework and no
backend. Tasks persist in `localStorage`, so the list survives a reload and
stays in sync between tabs.

## Run it

```bash
./run.sh          # then open http://127.0.0.1:8123/
./run.sh 9000     # different port
```

Any static file server works (`python3 -m http.server`, `npx serve`, dragging
`index.html` into a browser). `run.sh` just wraps the first option.

## What iteration 1 does

| Behaviour | How |
| --- | --- |
| Add a task | Type and press **Enter**, or press **Add** |
| Ignore junk input | Empty and whitespace-only input adds nothing |
| Complete a task | Click the checkbox **or** the task text; Space works from the keyboard |
| Undo a completion | Click it again |
| Delete a task | The per-row **Delete** button |
| Count remaining | "3 tasks left" / "1 task left" / "No tasks left — all done" |
| Survive a reload | Saved to `localStorage` on every change |
| Survive bad data | Corrupt JSON or malformed records are dropped, not fatal |
| Stay in sync | Two open tabs both update when either one changes |

## Explicitly not in this iteration

Editing text, due dates, priorities, projects/tags, filters, drag-to-reorder,
multi-user sync, a server backend. The data model and the render split below are
what let those land later without a rewrite.

## Files

```
index.html   markup + the one <form> that makes Enter work for free
style.css    design tokens, mobile-first layout, states
app.js       state, persistence, rendering, event wiring
run.sh       starts a static server on :8123
```

## Data model

One task:

```js
{ id: "mwwq3t4u-bhaa1h", text: "Buy milk", done: false, createdAt: 1764129970000 }
```

Stored as a JSON array under the versioned key `todo.tasks.v1`. The version in
the key means a later iteration that adds a backend can recognise this data and
migrate it instead of clobbering it. Ids are stable strings, never array
indexes — rows move when you delete or filter, and every later feature
(`PATCH /tasks/:id`) needs an id that survives that.

## The one architectural rule

**Mutators change state, then call `render()`. `render()` reads state and never
inspects the DOM to work out what the data is.**

`addTask` / `toggleTask` / `removeTask` are the only places `tasks` changes.
`render()` wipes the list and rebuilds every row from `tasks`. That is slightly
wasteful and completely correct: the DOM can never drift out of sync with the
state, and per-row listeners can never go stale — which is why the list has
exactly two delegated listeners (`change` for toggle, `click` for delete)
instead of two per row.

Text is always set with `textContent`, never `innerHTML`, so task text can never
be parsed as HTML.

## Deliberate small-screen choices

Built for iPad Safari first, since that is where a to-do list actually gets
used:

- `font: inherit` on the input keeps it ≥16px — below that iOS zooms the whole
  page on focus and never un-zooms.
- The task text is a `<label for>` on the checkbox, so tapping the words ticks
  the box: a ~60px-tall touch target rather than the 28px checkbox alone.
- 44px minimum control heights, `env(safe-area-inset-bottom)` padding,
  `overflow-wrap: anywhere` so a long URL wraps instead of shoving Delete
  off-screen.
- `prefers-reduced-motion` and `:focus-visible` honoured; the count is
  `aria-live="polite"`; Delete carries an `aria-label` naming the task.
- Focus is restored to the control you just acted on, so a keyboard user isn't
  thrown to the top of the page after a toggle.

## Verification

Behaviour was checked in real headless Chromium, not by reading the code. The
harness lives outside the app folder (`.ux-verify/`) so the app stays
dependency-free: `node_modules`, a downloaded Chromium build and its `.so`
dependencies all sit there.

```bash
/opt/code-server/config/workspace/.ux-verify/todo/verify.sh p1   # add-path checks
/opt/code-server/config/workspace/.ux-verify/todo/verify.sh p2   # everything else
```

15 checks, all passing, with **zero** console errors, page errors or failed
requests:

1. Fresh storage → empty state, no stray writes
2. Add with Enter → row appears, input cleared, focus kept
3. Add with the button
4. Empty and whitespace-only input → nothing added, no blank rows
5. Three tasks → correct count and `localStorage` contents
6. Checkbox toggle → `line-through`, count drops, storage updated
7. Label-text click toggles too
8. Keyboard Space toggles and keeps focus inside the list
9. Delete removes the row and the stored record
10. Identical state after a full reload
11. `<img onerror>` / `<script>` in task text render as text — no images, no injected scripts, no `window.__pwned`
12. Bad JSON and mixed junk records → app starts clean/valid instead of crashing
13. Controls measure 54/54/50px, input font 20px
14. 360px viewport, long unbreakable URL → no horizontal scroll, Delete still on screen
15. Two-tab sync in both directions via the `storage` event

Screenshots from those runs: `.ux-verify/todo/evidence/`.

## Likely iteration 2

Editing a task in place, then filters (all / active / completed). Both slot into
the existing shape: edit needs a new mutator plus a second delegated listener,
and filters need a `visibleTasks()` derived query in front of the render loop —
`tasks` itself stays unfiltered.

# To-Do List — iteration 3

A to-do list that runs in a browser with no build step, no framework and no
backend. Tasks persist in `localStorage` through a single async storage module
(`storage.js`), so the list survives a reload and stays in sync between tabs.
All storage is awaited by the UI; the UI never touches `localStorage` directly,
so a network CalDAV backend can replace the internals later without touching
UI code.

## Run it

```bash
./run.sh          # then open http://127.0.0.1:8123/
./run.sh 9000     # different port
```

Any static file server works (`python3 -m http.server`, `npx serve`, dragging
`index.html` into a browser). `run.sh` just wraps the first option.

## What iteration 3 does

| Behaviour | How |
| --- | --- |
| Add a task | Type and press **Enter**, or press **Add**; optional due date |
| Multiple lists | Sidebar lists: create, rename, recolor, delete (with in-page confirm). A default "My Tasks" list always exists and can never be deleted. Tap a list to switch; the toggle «» collapses the rail |
| Subtasks | **→** indents a task under the one above it (whole subtree moves), **←** outdents it back; **▾/▸** collapses/expands the subtree. Nested to any depth |
| Completing a parent | Ticking a task that has open subtasks asks whether to complete them too ("Complete all" / "Keep separate" / "Cancel") |
| Remaining count | "N tasks left" counts open tasks including open subtasks (an open parent stands in for its open subtree) |
| Task details panel | **i** opens a panel: multi-line notes, due date, and which list the task lives in. Changing the list moves the task **and all its subtasks** |
| Drag to reorder | Pointer-event drag (works with touch on iPad); Alt+↑/↓ as the keyboard path |
| Count / overdue / filters / clear-completed | As in iteration 2, now per list |
| Survive a reload | All reads/writes go through `TodoStorage` (async Promises) backed by one versioned blob |
| Migrate old installs | Iteration-1/2 data is copied into the new blob under "My Tasks"; the old keys are left in place |
| Stay in sync | Two open tabs both update when either one changes |

## Explicitly not in this iteration

Priorities, tags, multi-user sync, a network backend. The data model and the
render split below are what let a CalDAV backend land later without touching
UI code.

## Files

```
index.html   markup: sidebar shell, add form, detail panel shell
style.css    design tokens, mobile-first layout, sidebar/subtask states
storage.js   the ONLY module that touches localStorage (async Promises)
app.js       state, rendering, event wiring — awaits storage, never localStorage
run.sh       starts a static server on :8123
```

## Data model

Each task (maps 1:1 onto a VTODO record later):

```js
{
  uid: "9d66e9db-644b-41a6-a600-816ceaaf37c7",  // UUID, stable, never an array index
  summary: "Ship the release",
  description: "multi-line notes",
  due: "2026-11-27" | null,                     // ISO date; becomes VTODO DUE
  status: "NEEDS-ACTION" | "COMPLETED",         // becomes VTODO STATUS
  completed: 1764129970000 | null,              // becomes VTODO COMPLETED
  parentUid: null | uid,                        // null for top level; maps to RELATED-TO
  listId: "list-default" | uid,                 // which calendar collection the task lives in
  order: 0,                                     // within-list ordering
  created: 1764129970000,
  lastModified: 1764129970000
}
```

Each list (maps to a CalDAV calendar collection):

```js
{ id: "list-default", name: "My Tasks", color: "#0b57d0", order: 0 }
```

Stored as one JSON blob under the versioned key `todo.tasks.v3`:
`{ tasks: […], lists: […] }`. A versioned key means a later backend can
recognise and migrate the data instead of clobbering it. Ids are stable UUIDs,
never array indexes — rows move when you delete, reorder or switch lists, and
a `PATCH /calendars/:list/todos/:uid` later needs an id that survives that.

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
node /opt/code-server/config/workspace/.ux-verify/todo/p1.js   # add-path checks
node /opt/code-server/config/workspace/.ux-verify/todo/p2.js   # toggle / delete / reload / mobile
node /opt/code-server/config/workspace/.ux-verify/todo/p3.js   # edit, due dates, filters, drag
node /opt/code-server/config/workspace/.ux-verify/todo/p4.js   # iteration 3: lists, subtasks, details
```

All checks pass with **zero** console errors, page errors or failed requests:

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

Iteration 3 adds 15 more checks in `p4.js`: the default "My Tasks" list,
list create / rename / recolor / switch / delete-with-confirm, subtask
nesting, indent / outdent moving whole subtrees, collapse / expand,
the complete-parent prompt, the remaining-count rule, the details panel
(notes, due, move-to-list carrying the whole subtree), and the v1 / v2
→ v3 migration keeping every old record under "My Tasks".

Screenshots from those runs: `.ux-verify/todo/evidence/`.

## Likely iteration 4

A network CalDAV backend (Radicale). `storage.js` already speaks the
`loadAll` / `saveTask` / `deleteTask` / `saveList` / `deleteList` Promise
contract, so only its internals get swapped — lists become calendar
collections and tasks become VTODO records — while the UI stays exactly as it
is.

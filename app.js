/* =============================================================
 * To-Do List — iteration 2
 *
 * Layer order, same as iteration 1:
 *   1. constants + DOM references
 *   2. storage availability check
 *   3. helpers (ids, dates, normalising, migration)
 *   4. persistence (load / save)
 *   5. state + mutators        <- the ONLY place `tasks` is changed
 *   6. derived queries
 *   7. rendering               <- reads state, never writes it
 *   8. event wiring
 *   9. boot
 *
 * Golden rule, unchanged: a mutator changes state and then calls render().
 * render() rebuilds the UI from state and never inspects the DOM to find out
 * what the data is.
 *
 * Iteration 2 adds: inline edit, optional due date + overdue flag, filters,
 * clear-completed, and drag-to-reorder (pointer events, so it works on iPad).
 * Two kinds of state, deliberately kept apart:
 *   data — `tasks`                          -> persisted
 *   ui   — filter / editing / draft / drag  -> memory only, because a reload
 *          should never hide half your list or restore a half-typed edit box.
 * ============================================================= */

"use strict";

/* ---------- 1. Constants + DOM references ---------- */

// Iteration 2 bumped the storage key, because the task shape grew two fields
// (dueDate, updatedAt). Bumping buys two things a tolerant reader alone cannot:
//   - rollback safety — todo.tasks.v1 is left untouched, so if iteration 2 ever
//     misbehaves, the iteration-1 data is still on the device, unwritten;
//   - an unambiguous schema marker — the key tells you which shape the blob is,
//     instead of you having to guess from which fields happen to be present.
// The cost is one extra key in storage, and it is paid for by loadTasks(), which
// copies v1 forward on first launch (see the migration note there).
const STORAGE_KEY = "todo.tasks.v2";
const LEGACY_KEY = "todo.tasks.v1";
const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const els = {
  form: document.getElementById("add-form"),
  input: document.getElementById("new-task"),
  dueInput: document.getElementById("new-due"),
  clearDue: document.getElementById("clear-due"),
  count: document.getElementById("count"),
  overdue: document.getElementById("overdue-line"),
  filters: document.getElementById("filters"),
  clearCompleted: document.getElementById("clear-completed"),
  list: document.getElementById("task-list"),
  empty: document.getElementById("empty-state"),
  warning: document.getElementById("storage-warning"),
  announce: document.getElementById("announce"),
};

/* ---------- 2. Is localStorage actually usable here? ---------- */

// Safari private mode / blocked cookies throw on the first touch, so probe once.
// If it fails the app still works — just for one page load.
let storageAvailable = false;

function checkStorage() {
  try {
    const probe = STORAGE_KEY + ".probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (error) {
    return false;
  }
}

function readKey(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

/* ---------- 3. Helpers ---------- */

// Stable ids, never array indexes: rows shift when you delete, filter or
// reorder, and anything address-based (a future PATCH /tasks/:id) needs an id
// that survives all of that.
function createId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Today as a plain calendar date in the USER's timezone. Deliberately a string,
// not a timestamp: new Date("2026-11-26") parses as UTC midnight, so a task due
// today would flip to overdue depending on the reader's UTC offset. A YYYY-MM-DD
// string compares correctly lexicographically and never shifts.
function todayISO() {
  const now = new Date();
  return (
    now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate())
  );
}

function normalizeDueDate(value) {
  return typeof value === "string" && DUE_DATE_PATTERN.test(value) ? value : null;
}

// One v2 task: { id, text, done, createdAt, dueDate, updatedAt }
// Unknown or absent fields are tolerated on purpose: an iteration-1 record
// simply lacks dueDate/updatedAt, so it normalises straight into v2.
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text === "") return null;

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();

  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : createId(),
    text: text,
    done: raw.done === true,
    createdAt: createdAt,
    dueDate: normalizeDueDate(raw.dueDate),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

function parseTaskArray(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) return []; // someone wrote junk: start clean
    return parsed.map(normalizeTask).filter((task) => task !== null);
  } catch (error) {
    return []; // corrupt JSON is not worth a blank white page
  }
}

/* ---------- persistence ---------- */

// Iteration 2 reads todo.tasks.v2. Iteration 1 wrote todo.tasks.v1, so a real
// user's list lives there and MUST NOT disappear on upgrade.
//
// The good news is that the two shapes are nearly identical: an iteration-1
// record ({ id, text, done, createdAt }) simply lacks dueDate/updatedAt, and
// normalizeTask() — which runs on EVERY read — fills dueDate:null and
// updatedAt:createdAt. So migrating is not a special parser, it is the same
// tolerant reader the app already uses for junk data.
//
// Rules, in order of importance:
//   - v2 wins if present (a returning v2 user never gets clobbered by old data)
//   - otherwise copy v1 forward, preserving array order — iteration 1 already
//     stored order as array order, so a user's existing sequence survives for
//     free now that order is user-facing
//   - v1 is left exactly as it was, so downgrading to iteration 1 is still
//     possible and a failed upgrade is never destructive
function loadTasks() {
  const current = readKey(STORAGE_KEY);
  if (current !== null) return parseTaskArray(current);

  const legacy = readKey(LEGACY_KEY);
  if (legacy === null) return [];

  const migrated = parseTaskArray(legacy);

  // Write v2 straight away rather than waiting for the first mutation: if the
  // user opens the app and closes it, their tasks are already safe in the new
  // key instead of being one bad write away from gone.
  saveTasks(migrated);
  return migrated;
}

function saveTasks(list) {
  if (!storageAvailable) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    storageAvailable = false;
    showWarning(
      "Storage is full, so changes made now will disappear when you reload."
    );
  }
}

/* ---------- 5. State + mutators ---------- */

let tasks = [];

// UI-only state. Kept out of `tasks` so persistence stays a pure data concern.
const ui = {
  filter: "all", // "all" | "active" | "completed"
  editingId: null, // id of the row showing an edit box, or null
  draft: "", // text inside the edit box (unsaved)
  draftDue: null, // due date inside the edit box (unsaved)
  dragId: null, // id being dragged, or null
  dragOverId: null, // id the drop gap is sitting above, or null
};

function findTask(id) {
  return tasks.find((task) => task.id === id) || null;
}

function addTask(text, dueDate) {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const now = Date.now();
  const task = {
    id: createId(),
    text: trimmed,
    done: false,
    createdAt: now,
    dueDate: normalizeDueDate(dueDate),
    updatedAt: now,
  };

  tasks = [...tasks, task];
  saveTasks(tasks);
  announce('Added "' + task.text + '"');
  render();
  return task;
}

function toggleTask(id) {
  tasks = tasks.map((task) =>
    task.id === id ? { ...task, done: !task.done, updatedAt: Date.now() } : task
  );
  saveTasks(tasks);
  render();
}

function deleteTask(id) {
  const target = findTask(id);
  tasks = tasks.filter((task) => task.id !== id);
  if (ui.editingId === id) {
    ui.editingId = null;
    ui.draft = "";
    ui.draftDue = null;
  }
  saveTasks(tasks);
  if (target) announce('Deleted "' + target.text + '"');
  render();
}

// Editing is a two-step flow (type, then commit or bail), so the box lives in
// `ui` and only writes to `tasks` when it is committed.
function beginEdit(id) {
  const task = findTask(id);
  if (!task) return;

  ui.editingId = id;
  ui.draft = task.text;
  ui.draftDue = task.dueDate;
  render();
  focusEditBox();
}

function commitEdit() {
  if (ui.editingId === null) return;

  const id = ui.editingId;
  const trimmed = ui.draft.trim();
  const nextDue = normalizeDueDate(ui.draftDue);

  // Empty text is not a valid task. Iteration 1 had no edit, so there was
  // nothing to decide here; clearing a task's text is plainly a deletion, and
  // silently keeping the old text would look like the app lost a keystroke.
  if (trimmed === "") {
    deleteTask(id);
    return;
  }

  const before = findTask(id);
  const changed =
    before !== null && (before.text !== trimmed || before.dueDate !== nextDue);

  tasks = tasks.map((task) =>
    task.id === id
      ? { ...task, text: trimmed, dueDate: nextDue, updatedAt: Date.now() }
      : task
  );

  ui.editingId = null;
  ui.draft = "";
  ui.draftDue = null;

  saveTasks(tasks);
  if (changed) announce("Task updated");
  render();
  refocusAddInput();
}

function cancelEdit() {
  if (ui.editingId === null) return;
  ui.editingId = null;
  ui.draft = "";
  ui.draftDue = null;
  render();
  refocusAddInput();
}

function updateDraft(value) {
  ui.draft = value;
}

function updateDraftDue(value) {
  ui.draftDue = normalizeDueDate(value);
}

function clearCompleted() {
  const removed = tasks.filter((task) => task.done).length;
  if (removed === 0) return;

  tasks = tasks.filter((task) => !task.done);
  if (ui.editingId !== null && findTask(ui.editingId) === null) {
    ui.editingId = null;
    ui.draft = "";
    ui.draftDue = null;
  }
  saveTasks(tasks);
  announce("Cleared " + removed + " completed task" + (removed === 1 ? "" : "s"));
  render();
}

// Reorder by stable id: `draggedId` lands where `targetId` was (or just after
// it). This is the shape a backend wants — a drag yields { draggedId, targetId,
// placeAfter }, not an index that is meaningless once other clients move things.
function moveTask(draggedId, targetId, placeAfter) {
  if (!draggedId || !targetId || draggedId === targetId) return;

  const from = tasks.findIndex((task) => task.id === draggedId);
  if (from === -1) return;

  const moved = tasks.splice(from, 1)[0];
  const targetIndex = tasks.findIndex((task) => task.id === targetId);
  if (targetIndex === -1) {
    tasks.splice(from, 0, moved); // target vanished mid-drag; put it back
    render();
    return;
  }

  tasks.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, moved);

  saveTasks(tasks);
  announce("Reordered");
  render();
}

/* ---------- 6. Derived queries ---------- */

// Order = array order = the user's order. Never re-sorted for display: reorder
// is now a feature, so display order must be exactly storage order.
function visibleTasks() {
  if (ui.filter === "active") return tasks.filter((task) => !task.done);
  if (ui.filter === "completed") return tasks.filter((task) => task.done);
  return tasks;
}

// Incomplete AND strictly before today. "Due today" is NOT overdue.
function isOverdue(task) {
  return task.done === false && task.dueDate !== null && task.dueDate < todayISO();
}

function overdueCount() {
  return tasks.filter(isOverdue).length;
}

/* ---------- 7. Rendering ---------- */

// render() always rebuilds the whole list from state. That is the point: there
// is exactly one way the UI can look, and it is impossible for a mutator to
// "forget" to update one corner of the DOM (the #1 source of iteration-1-style
// bugs). Focus is captured before the rebuild and restored after, so a rebuild
// triggered by another tab mid-edit does not steal the caret.
function render() {
  const focusKey = captureFocusKey();

  els.list.innerHTML = "";
  const shown = visibleTasks();

  const fragment = document.createDocumentFragment();
  for (const task of shown) {
    fragment.appendChild(task.done ? buildCompletedRow(task) : buildRow(task));
  }
  els.list.appendChild(fragment);

  renderEmptyState(shown.length);
  renderStats();
  renderControls();
  refreshDragLine();
  restoreFocus(focusKey);
}

function buildRow(task) {
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.id = task.id;
  if (ui.editingId === task.id) return buildEditRow(li, task);
  if (ui.dragId === task.id) li.classList.add("is-dragging");

  li.appendChild(buildGrip(task));

  // Class names and the label-wrapping trick are exactly iteration 1's: the task
  // text is a <label for>, so tapping the words ticks the box. That is what makes
  // the 28px checkbox comfortable on touch, and it is what the iteration-1 tests
  // click — keeping the contract is why those tests still pass.
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-check";
  checkbox.id = "task-check-" + task.id;
  checkbox.checked = task.done;
  checkbox.dataset.action = "toggle";
  checkbox.dataset.focusKey = "check:" + task.id;
  checkbox.setAttribute("aria-label", "Mark “" + task.text + "” complete");

  const text = document.createElement("label");
  text.className = "task-text";
  text.htmlFor = checkbox.id;
  text.textContent = task.text;
  text.title = "Double-click to edit · click to tick";

  // Text + due date share one flexible column and stack when space runs out.
  // Five siblings in one grid row is what pushed Delete off-screen at 360px in
  // iteration 1's layout, and the wrap has to be the design, not an accident.
  const main = document.createElement("div");
  main.className = "task-main";
  main.append(text, buildDueBadge(task));

  li.append(checkbox, main, buildActions(task));
  return li;
}

function buildCompletedRow(task) {
  const li = buildRow(task);
  li.classList.add("done"); // iteration-1 class name, still what CSS keys off
  return li;
}

function buildEditRow(li, task) {
  li.classList.add("is-editing");

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "edit-text";
  textInput.value = ui.draft;
  textInput.dataset.action = "draft";
  textInput.dataset.focusKey = "edit-text:" + task.id;
  textInput.setAttribute("aria-label", "Task text");

  const dueInput = document.createElement("input");
  dueInput.type = "date";
  dueInput.className = "edit-due";
  dueInput.value = ui.draftDue || "";
  dueInput.dataset.action = "draft-due";
  dueInput.dataset.focusKey = "edit-due:" + task.id;
  dueInput.setAttribute("aria-label", "Due date");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.textContent = "Save";
  save.dataset.action = "save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.textContent = "Cancel";
  cancel.dataset.action = "cancel";

  const hint = document.createElement("span");
  hint.className = "edit-hint";
  hint.textContent = "Enter saves · Esc cancels";

  li.append(textInput, dueInput, save, cancel, hint);
  return li;
}

function buildGrip(task) {
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.dataset.role = "grip";
  grip.dataset.focusKey = "grip:" + task.id;
  grip.setAttribute("role", "button");
  grip.setAttribute("tabindex", "0");
  grip.setAttribute("aria-label", "Reorder “" + task.text + "”. Alt+Up or Alt+Down moves it.");
  grip.textContent = "⋮⋮";
  return grip;
}

function buildActions(task) {
  const wrap = document.createElement("div");
  wrap.className = "row-actions";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-btn task-edit";
  edit.dataset.action = "edit";
  edit.dataset.focusKey = "edit:" + task.id;
  edit.setAttribute("aria-label", "Edit “" + task.text + "”");
  edit.textContent = "✎";

  // Still .task-delete, because both the iteration-1 CSS and the iteration-1
  // tests reach the trash button by that name.
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn task-delete";
  remove.dataset.action = "delete";
  remove.dataset.focusKey = "delete:" + task.id;
  remove.setAttribute("aria-label", "Delete “" + task.text + "”");
  remove.textContent = "✕";

  wrap.append(edit, remove);
  return wrap;
}

function buildDueBadge(task) {
  const badge = document.createElement("span");
  badge.className = "due";

  if (task.dueDate === null) {
    badge.dataset.dueState = "none";
    badge.textContent = "";
    badge.setAttribute("aria-hidden", "true");
    return badge;
  }

  const overdue = isOverdue(task);
  badge.dataset.dueState = overdue ? "overdue" : task.done ? "done" : "open";
  badge.textContent = formatDueLabel(task.dueDate);
  badge.title = overdue ? "Overdue — was due " + task.dueDate : "Due " + task.dueDate;
  return badge;
}

// Built from the date parts, not new Date(iso): new Date("2026-11-26") is UTC
// midnight, so in a negative-offset timezone the label would print the day
// before. timeZone:"UTC" reads back exactly the calendar day we stored.
function formatDueLabel(iso) {
  const diff = dayDiffFromToday(iso);
  if (diff === 0) return "Due today";
  if (diff === -1) return "Due tomorrow";
  if (diff === 1) return "Overdue yesterday";

  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const label = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return diff > 0 ? "Overdue " + label : "Due " + label;
}

// Positive = in the past.
function dayDiffFromToday(iso) {
  const target = Date.parse(iso + "T00:00:00Z");
  const today = Date.parse(todayISO() + "T00:00:00Z");
  return Math.round((today - target) / 86400000);
}

function renderEmptyState(shownCount) {
  if (shownCount > 0) {
    els.empty.hidden = true;
    return;
  }

  els.empty.hidden = false;

  // "Nothing here" means different things: no tasks at all, or tasks the current
  // filter is hiding. Saying "add your first task" above a list of ten completed
  // ones would be plainly wrong.
  const message =
    tasks.length === 0
      ? "Nothing here yet. Add your first task above."
      : ui.filter === "active"
        ? "No active tasks — everything is checked off."
        : "Nothing completed yet. Tick a task to see it here.";

  els.empty.textContent = message;
}

function renderStats() {
  const active = tasks.filter((task) => !task.done).length;
  els.count.textContent =
    active + " " + (active === 1 ? "task" : "tasks") + " left";

  const overdue = overdueCount();
  els.overdue.hidden = overdue === 0;
  els.overdue.textContent =
    overdue + " overdue — catch up on the ones that slipped.";
}

// Filter + Clear-completed availability live here, not in the click handlers, so
// the controls can never disagree with the data.
function renderControls() {
  for (const button of els.filters.querySelectorAll("button")) {
    const isActive = button.dataset.filter === ui.filter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  const completed = tasks.filter((task) => task.done).length;
  els.clearCompleted.disabled = completed === 0;
  els.clearCompleted.textContent =
    completed === 0 ? "Clear completed" : "Clear completed (" + completed + ")";
}

/* ---------- focus care ---------- */

// Every focusable row control carries a data-focus-key. If a render happens
// while one of them has focus (cross-tab sync mid-edit, say), we put the caret
// back rather than dumping the user on the add input.
function captureFocusKey() {
  const active = document.activeElement;
  if (!active || !els.list.contains(active)) return null;
  const key = active.dataset.focusKey;
  if (!key) return null;

  let caret = null;
  if (typeof active.selectionStart === "number") {
    caret = [active.selectionStart, active.selectionEnd];
  }
  return { key: key, caret: caret };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const target = els.list.querySelector('[data-focus-key="' + snapshot.key + '"]');
  if (!target) return;

  target.focus({ preventScroll: true });
  if (snapshot.caret && typeof target.setSelectionRange === "function") {
    try {
      target.setSelectionRange(snapshot.caret[0], snapshot.caret[1]);
    } catch (error) {
      /* type=input/date rejects a range on some engines; focus is enough */
    }
  }
}

function focusEditBox() {
  if (ui.editingId === null) return;
  const input = els.list.querySelector(
    '[data-focus-key="edit-text:' + ui.editingId + '"]'
  );
  if (!input) return;
  input.focus({ preventScroll: false });
  input.setSelectionRange(input.value.length, input.value.length);
}

function refocusAddInput() {
  els.input.focus({ preventScroll: true });
}

/* ---------- small UI utilities ---------- */

let warningShown = false;

function showWarning(message) {
  if (warningShown) return;
  warningShown = true;
  els.warning.textContent = message;
  els.warning.hidden = false;
}

// Screen-reader channel. Iteration 1 deleted rows without saying so; a rebuild
// that removes focus should at least announce what happened.
function announce(message) {
  els.announce.textContent = message;
}

/* ---------- 8. Event wiring ---------- */

/*
 * One click/change/input/keydown listener on the list, not one per row. Rows are
 * destroyed and recreated on every render, so per-row listeners would either
 * leak or silently detach. Handlers read data-action, so DOM order is irrelevant.
 */
// A double-click on the task text arrives as the label's own click (which
// carries detail=2, the browser's own click counter) plus two label-forwarded
// clicks on the checkbox. The native dblclick event never reaches us, because
// the first toggle re-renders and re-creates the row mid-gesture. So the label
// click plants a flag and the matching forwarded toggle consumes it.
let pendingTextEdit = null;
let lastPointerType = "";

function wireListEvents() {
  els.list.addEventListener("click", (event) => {
    if (drag.suppressClick) {
      drag.suppressClick = false;
      return;
    }

    const textEl = event.target.closest 
      ? event.target.closest(".task-text")
      : null;
    if (
      textEl &&
      event.detail >= 2 &&
      lastPointerType !== "touch"
    ) {
      // detail=2 is the double-click. On touch, quick double-taps are common
      // while ticking boxes, and the Edit button is the intended edit entry
      // there, so a double-tap must keep doing nothing but ticking.
      pendingTextEdit = textEl.closest("li.task").dataset.id;
    }

    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !els.list.contains(actionEl)) return;

    const row = actionEl.closest("li.task");
    if (!row) return;
    const id = row.dataset.id;

    if (actionEl.dataset.action === "toggle" && pendingTextEdit === id) {
      pendingTextEdit = null;
      // The first click of the double-click already ticked the box. Flipping it
      // back before opening the editor is what makes "double-click to edit"
      // never silently change a task's completion state.
      toggleTask(id);
      beginEdit(id);
      return;
    }

    switch (actionEl.dataset.action) {
      case "toggle":
        toggleTask(id);
        break;
      case "edit":
        beginEdit(id);
        break;
      case "delete":
        deleteTask(id);
        break;
      case "save":
        commitEdit();
        break;
      case "cancel":
        cancelEdit();
        break;
    }
  });

  // Double-click anywhere on a row (except its controls) opens the editor.
  els.list.addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-action], [data-role='grip']")) return;
    const row = event.target.closest("li.task");
    if (row) beginEdit(row.dataset.id);
  });

  els.list.addEventListener("change", (event) => {
    if (event.target.dataset.action === "draft-due") {
      updateDraftDue(event.target.value);
    }
  });

  // Draft keystrokes update ui.draft WITHOUT re-rendering: typing must not
  // rebuild the list under the caret.
  els.list.addEventListener("input", (event) => {
    if (event.target.dataset.action === "draft") updateDraft(event.target.value);
  });

  els.list.addEventListener("keydown", (event) => {
    const row = event.target.closest("li.task");
    if (!row) return;

    if (event.target.dataset.action === "draft") {
      if (event.key === "Enter") {
        event.preventDefault();
        commitEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      }
      return;
    }

    // Keyboard reorder: pointer drag is unreachable without a mouse or touch,
    // and Alt+Arrows keeps a keyboard/screen-reader user in the game.
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const shown = visibleTasks();
      const index = shown.findIndex((task) => task.id === row.dataset.id);
      const neighbour = shown[index + direction];
      if (!neighbour) return;

      const focusKey = event.target.dataset.focusKey;
      moveTask(row.dataset.id, neighbour.id, direction === 1);

      const refocused = els.list.querySelector(
        '[data-focus-key="' + focusKey + '"]'
      );
      if (refocused) refocused.focus({ preventScroll: true });
    }
  });
}

/* ---------- drag to reorder (pointer events, works with touch on iPad) ---------- */

/*
 * Deliberately NOT HTML5 drag-and-drop: dnd does not work on iOS/iPadOS Safari
 * at all (no touch drag support), and it fights with re-rendering. Pointer
 * events cover mouse, pen and touch with a single code path.
 *
 * The grip is the only drag handle, and it carries touch-action:none in CSS.
 * That is what makes dragging work on a tablet: without it the browser claims
 * the gesture for scrolling and pointermove never fires. Letting the whole row
 * be a handle would make the list impossible to scroll on a phone.
 *
 * This is the ONE place that touches the DOM outside render(). It toggles a
 * class and moves a guide line without re-rendering, because a render mid-drag
 * would destroy the element holding pointer capture and drop the row out from
 * under the user's finger. It never changes state, so the invariant holds.
 */
const drag = {
  pointerId: null,
  grip: null,
  placeAfter: false,
  line: null,
  suppressClick: false,
};

function ensureDropLine() {
  if (drag.line) return drag.line;
  drag.line = document.createElement("div");
  drag.line.className = "drop-line";
  drag.line.hidden = true;
  els.list.appendChild(drag.line);
  return drag.line;
}

function startDrag(row, grip, event) {
  if (ui.editingId === row.dataset.id) return;

  ui.dragId = row.dataset.id;
  ui.dragOverId = null;
  drag.pointerId = event.pointerId;
  drag.grip = grip;
  drag.placeAfter = false;

  try {
    grip.setPointerCapture(event.pointerId);
  } catch (error) {
    /* capture is a nicety; the window listeners below do the real work */
  }

  row.classList.add("is-dragging");
  els.list.classList.add("is-reordering");
  ensureDropLine();

  event.preventDefault();
}

function onDragMove(event) {
  if (ui.dragId === null || event.pointerId !== drag.pointerId) return;

  const under = document.elementFromPoint(event.clientX, event.clientY);
  const row = under ? under.closest("li.task") : null;
  if (!row || !els.list.contains(row) || row.dataset.id === ui.dragId) return;

  const rect = row.getBoundingClientRect();
  drag.placeAfter = event.clientY > rect.top + rect.height / 2;
  ui.dragOverId = row.dataset.id;

  positionDropLine(row, drag.placeAfter);
}

function positionDropLine(row, placeAfter) {
  const line = ensureDropLine();
  const listRect = els.list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();

  line.hidden = false;
  line.style.top = (placeAfter ? rowRect.bottom : rowRect.top) - listRect.top + "px";
}

// Called at the end of every render() so the guide can never point at a row that
// no longer exists (another tab deleted it mid-drag).
function refreshDragLine() {
  if (ui.dragId === null || !drag.line) return;

  const row = ui.dragOverId
    ? els.list.querySelector('li.task[data-id="' + ui.dragOverId + '"]')
    : null;

  if (!row) {
    ui.dragOverId = null;
    drag.line.hidden = true;
    return;
  }
  positionDropLine(row, drag.placeAfter);
}

function endDrag(commit) {
  if (ui.dragId === null) return;

  const draggedId = ui.dragId;
  const targetId = ui.dragOverId;
  const placeAfter = drag.placeAfter;

  const row = els.list.querySelector('li.task[data-id="' + draggedId + '"]');
  if (row) row.classList.remove("is-dragging");
  els.list.classList.remove("is-reordering");
  if (drag.line) drag.line.hidden = true;

  ui.dragId = null;
  ui.dragOverId = null;
  drag.pointerId = null;
  drag.grip = null;

  // A completed drag is followed by a synthetic click on the grip; swallowing it
  // stops a stray edit/toggle after the drop.
  if (commit && targetId && targetId !== draggedId) {
    drag.suppressClick = true;
    moveTask(draggedId, targetId, placeAfter);
  }
}

function wireDragEvents() {
  els.list.addEventListener("pointerdown", (event) => {
    // The click event that follows a press does not say what pressed it, so
    // remember the pointer type here for the click handler's double-click rule.
    lastPointerType = event.pointerType || "mouse";

    const grip = event.target.closest("[data-role='grip']");
    if (!grip) return;

    const row = grip.closest("li.task");
    if (!row) return;

    startDrag(row, grip, event);
  });

  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", () => endDrag(true));
  window.addEventListener("pointercancel", () => endDrag(false));
}

/* ---------- add form, filters, clear completed ---------- */

function wireToolbar() {
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();

    const added = addTask(els.input.value, els.dueInput.value);
    if (!added) {
      els.input.focus();
      return;
    }

    els.input.value = "";
    els.dueInput.value = "";
    syncClearDue();
    els.input.focus();
  });

  els.clearDue.addEventListener("click", () => {
    els.dueInput.value = "";
    syncClearDue();
    els.dueInput.focus();
  });

  els.filters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button || button.dataset.filter === ui.filter) return;

    // A filter can hide the row being edited, which would leave an orphaned
    // draft behind. Discarding it is the least surprising outcome.
    if (ui.editingId !== null) {
      ui.editingId = null;
      ui.draft = "";
      ui.draftDue = null;
    }

    ui.filter = button.dataset.filter;
    render();
  });

  els.clearCompleted.addEventListener("click", clearCompleted);
}

// The "✕ next to the date" affordance only makes sense while a date is set; a
// dead button next to an empty field is noise.
function syncClearDue() {
  els.clearDue.hidden = els.dueInput.value === "";
}

function wireDueField() {
  els.dueInput.addEventListener("input", syncClearDue);
  syncClearDue();
}

/* ---------- other tabs ---------- */

// A storage event means another tab changed the data. Re-reading and re-rendering
// is all it takes — the same "state in, UI out" rule that makes this cheap.
function wireStorageSync() {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    if (ui.dragId !== null) return; // never yank a row out from under a drag
    tasks = parseTaskArray(event.newValue);
    render();
  });
}

/* ---------- 9. Boot ---------- */

function boot() {
  storageAvailable = checkStorage();
  tasks = loadTasks();

  wireToolbar();
  wireDueField();
  wireListEvents();
  wireDragEvents();
  wireStorageSync();

  render();

  if (!storageAvailable) {
    showWarning(
      "This browser is blocking storage, so your tasks will vanish when you reload."
    );
  }

  // "Overdue" is a function of the calendar day, so a list left open across
  // midnight must re-flag itself without a reload. Cheap check, once a minute.
  let day = todayISO();
  setInterval(() => {
    const today = todayISO();
    if (today === day) return;
    day = today;
    render();
  }, 60000);
}

boot();








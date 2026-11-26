/* =============================================================
 * To-Do List — iteration 1
 *
 * Layers in this file (later iterations add to these, not around them):
 *   1. constants + DOM references
 *   2. storage availability check
 *   3. helpers (id generation, normalising loaded records)
 *   4. persistence (load / save)
 *   5. state + mutators        <- the ONLY place `tasks` is changed
 *   6. derived queries
 *   7. rendering               <- reads state, never writes it
 *   8. event wiring
 *   9. boot
 *
 * Golden rule: mutators change state and then call render().
 * render() rebuilds the UI from state and never inspects the DOM to work
 * out what the data is. Editing, due dates, filtering and a backend all
 * hang off that split.
 * ============================================================= */

"use strict";

/* ---------- 1. Constants + DOM references ---------- */

// Versioned key: a later iteration that adds a backend can detect and
// migrate old local data rather than lose it.
const STORAGE_KEY = "todo.tasks.v1";

const els = {
  form: document.getElementById("add-form"),
  input: document.getElementById("new-task"),
  count: document.getElementById("count"),
  list: document.getElementById("task-list"),
  empty: document.getElementById("empty-state"),
  warning: document.getElementById("storage-warning"),
};

/* ---------- 2. Is localStorage actually usable here? ---------- */

// Safari private-mode / blocked-cookies throw on the very first touch, so we
// probe once. If it fails the app still works, just for one page load.
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

/* ---------- 3. Helpers ---------- */

// Stable ids, never array indexes: rows shift when you delete or filter, and
// every future feature (edit, PATCH /tasks/:id) needs an id that survives.
function createId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// Shape of one task:
//   { id: string, text: string, done: boolean, createdAt: number }
// Turn whatever is sitting in storage into that shape, or return null so the
// caller can drop it. Unknown extra fields are ignored on purpose, which makes
// forward-compatible data cheap.
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text === "") return null;

  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : createId(),
    text: text,
    done: raw.done === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/* ---------- 4. Persistence ---------- */

function loadTasks() {
  if (!storageAvailable) return [];

  try {
    const rawList = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(rawList)) return []; // someone wrote junk: start clean
    return rawList.map(normalizeTask).filter((task) => task !== null);
  } catch (error) {
    return []; // corrupt JSON is not worth a blank white page
  }
}

function saveTasks() {
  if (!storageAvailable) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (error) {
    // Out of quota or permission revoked mid-session: keep the session alive
    // in memory. Every mutator calls render() right after saveTasks(), so the
    // warning banner appears without another render() here.
    storageAvailable = false;
  }
}

/* ---------- 5. State + mutators ---------- */

let tasks = [];

function addTask(rawText) {
  const text = (rawText || "").trim();
  if (text === "") return; // empty / whitespace-only input is ignored

  tasks.push({
    id: createId(),
    text: text,
    done: false,
    createdAt: Date.now(),
  });

  saveTasks();
  render();
}

function toggleTask(id) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) return;

  task.done = !task.done;
  saveTasks();
  render();
}

function removeTask(id) {
  const before = tasks.length;
  tasks = tasks.filter((candidate) => candidate.id !== id);
  if (tasks.length === before) return; // already gone, nothing to persist

  saveTasks();
  render();
}

/* ---------- 6. Derived queries ---------- */

// The single place the remaining count is computed.
function remainingCount() {
  return tasks.filter((task) => !task.done).length;
}

/* ---------- 7. Rendering ---------- */

// Build one <li> for one task.
function taskElement(task) {
  const li = document.createElement("li");
  li.className = task.done ? "task done" : "task";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-check";
  checkbox.checked = task.done;
  checkbox.id = "check-" + task.id;
  checkbox.dataset.id = task.id; // the delegated handlers read this
  checkbox.dataset.action = "toggle";

  // A <label> pointing at the checkbox: gives it an accessible name AND makes
  // the words themselves tappable, which is a far bigger target on iPad.
  const label = document.createElement("label");
  label.className = "task-text";
  label.htmlFor = checkbox.id;
  // textContent, never innerHTML — task text is user input and must not parse
  // as HTML.
  label.textContent = task.text;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "task-delete";
  remove.textContent = "Delete";
  remove.dataset.id = task.id;
  remove.dataset.action = "delete";
  remove.setAttribute("aria-label", "Delete task: " + task.text);

  li.append(checkbox, label, remove);
  return li;
}

// The one and only entry point for UI updates.
function render() {
  // Remember which control had focus so rebuilding the rows doesn't throw a
  // keyboard user back to the top of the page after a toggle.
  const active = document.activeElement;
  const focusedId =
    active && active.dataset ? active.dataset.id : null;

  // Wipe and rebuild from state. (appendChild-in-a-loop keeps the checkbox
  // state honest without a rebuild, but it also invites the DOM and the state
  // to drift apart — rebuilding is the boring, correct option at this size.)
  els.list.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const task of tasks) {
    fragment.append(taskElement(task));
  }
  els.list.append(fragment);

  renderCount();
  renderEmptyState();

  els.warning.hidden = storageAvailable;

  if (focusedId) {
    const restored = els.list.querySelector(
      '[data-id="' + CSS.escape(focusedId) + '"]'
    );
    if (restored) restored.focus();
  }
}

function renderCount() {
  const remaining = remainingCount();

  let text;
  if (remaining === 0) {
    text = tasks.length === 0 ? "No tasks yet" : "No tasks left — all done";
  } else if (remaining === 1) {
    text = "1 task left";
  } else {
    text = remaining + " tasks left";
  }

  els.count.textContent = text;
}

function renderEmptyState() {
  const hasTasks = tasks.length > 0;
  els.list.hidden = !hasTasks;
  els.empty.hidden = hasTasks;
}

/* ---------- 8. Event wiring ---------- */

function wireEvents() {
  // Handles both the Add button and the Enter / Return key.
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    addTask(els.input.value);
    els.input.value = ""; // cleared before anything else can re-submit
    els.input.focus(); // keep focus here for typing several tasks in a row
  });

  // One delegated listener pair for the whole list. render() recreates every
  // row, so per-row listeners would go stale (or leak).
  els.list.addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.action === "toggle") {
      toggleTask(target.dataset.id);
    }
  });

  els.list.addEventListener("click", (event) => {
    const target = event.target;
    if (target.dataset.action === "delete") {
      removeTask(target.dataset.id);
    }
  });

  // Two tabs/windows open on iPad stay in sync with the same saved list.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    tasks = loadTasks();
    render();
  });
}

/* ---------- 9. Boot ---------- */

function init() {
  storageAvailable = checkStorage();
  tasks = loadTasks();
  wireEvents();
  render();
}

init();

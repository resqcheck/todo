/* =============================================================
 * To-Do List — iteration 3
 *
 * Layer order, same spirit as before:
 *   1. constants + DOM references
 *   2. helpers (ids, dates, trees, ordering)
 *   3. state + mutators       <- the ONLY place `state.tasks`/`state.lists`
 *                                 change; each one calls render()
 *   4. derived queries
 *   5. rendering              <- reads state, never writes it
 *   6. event wiring
 *   7. boot (async: `await TodoStorage.loadAll()` before first render)
 *
 * Golden rule, unchanged: a mutator changes state and then calls render().
 * render() rebuilds the UI from state and never inspects the DOM to find out
 * what the data is.
 *
 * Iteration 3 adds:
 *   - multiple lists (create / rename / recolor / delete-with-confirm /
 *     switch) in a collapsible sidebar; "My Tasks" always exists;
 *   - subtasks to any depth: indent / outdent, collapse / expand, and a
 *     "complete its subtasks?" prompt when you finish a parent;
 *   - a task-details panel: notes, due date, and moving the whole task
 *     (subtree included) to another list;
 *   - all storage goes through TodoStorage (storage.js) with async functions
 *     that return Promises. The UI awaits them and never touches localStorage.
 *
 * Two kinds of state, deliberately kept apart:
 *   data — state.tasks / state.lists      -> persisted via TodoStorage
 *   ui   — filter / editing / collapsed / details / sidebar -> memory only
 * ============================================================= */

"use strict";

/* ---------- 1. Constants + DOM references ---------- */

const LIST_COLORS = [
  "#0b57d0", "#b0287c", "#0a7d3b", "#c25e00",
  "#5b21b6", "#0e7490", "#a3111f", "#374151",
];
const MAX_DEPTH = 8;

let els = {};

function bindEls() {
  const byId = (id) => document.getElementById(id);
  els = {
    form: byId("add-form"),
    input: byId("new-task"),
    dueInput: byId("new-due"),
    clearDue: byId("clear-due"),
    count: byId("count"),
    overdue: byId("overdue-line"),
    filters: byId("filters"),
    clearCompleted: byId("clear-completed"),
    list: byId("task-list"),
    empty: byId("empty-state"),
    warning: byId("storage-warning"),
    announce: byId("announce"),
    app: byId("app-shell"),
    sidebar: byId("lists-sidebar"),
    sidebarToggle: byId("sidebar-toggle"),
    listItems: byId("list-items"),
    newListForm: byId("new-list-form"),
    newListInput: byId("new-list-name"),
    detailPanel: byId("detail-panel"),
  };
}

/* ---------- 2. Helpers ---------- */

// Stable ids, never array indexes: rows shift when you delete, filter or
// reorder, and a CalDAV backend will need a uid that survives all of that.
function createUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "uid-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 10) + "-" +
    Math.random().toString(36).slice(2, 10);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Today as a plain calendar date in the USER's timezone (see iteration 2's
// comment on why a string, not a timestamp).
function todayISO() {
  const now = new Date();
  return (
    now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate())
  );
}

function normalizeDueDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function taskMap() {
  const map = new Map();
  for (const task of state.tasks) map.set(task.uid, task);
  return map;
}

function childrenOf(parentUid) {
  return state.tasks.filter((task) => task.parentUid === parentUid);
}

// `order` is the user's sequence; sort keeps subtask groups together.
function byOrder(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  return state.tasks.indexOf(a) - state.tasks.indexOf(b);
}

// uids of `uid` and every descendant, in display order.
function subtreeUids(uid) {
  const map = taskMap();
  const out = [];
  const visit = (id) => {
    out.push(id);
    const kids = childrenOf(id).slice().sort(byOrder);
    for (const kid of kids) visit(kid.uid);
  };
  if (map.has(uid)) visit(uid);
  return out;
}

function descendantsOf(uid) {
  return subtreeUids(uid).slice(1);
}

// Top-level tasks of one list, in display order.
function topLevelTasks(listId) {
  return state.tasks
    .filter((task) => task.listId === listId && task.parentUid === null)
    .sort(byOrder);
}

/* ---------- 3. State + mutators ---------- */

const state = {
  tasks: [],
  lists: [],
  currentListId: "list-default",
};

// UI-only state. Kept out of `state` so persistence stays a pure data concern.
const ui = {
  filter: "all", // "all" | "active" | "completed"
  editingId: null, // uid of the row showing an edit box, or null
  draft: "", // summary inside the edit box (unsaved)
  draftDue: null, // due date inside the edit box (unsaved)
  collapsed: new Set(), // uids whose subtree is hidden (memory only)
  detailsUid: null, // uid whose details panel is open, or null
  listMenuId: null, // list whose delete-confirm card is open, or null
  sidebarCollapsed: false, // memory only: a wide iPad that reloads stays open
  listDraftColor: null, // colour picked for a not-yet-created list
  pendingPrompt: null, // { uid, openCount } — the "complete subtasks?" card
  dragId: null, // uid being dragged, or null
  dragOverId: null, // uid the drop gap is sitting above, or null
};

function findTask(uid) {
  return state.tasks.find((task) => task.uid === uid) || null;
}

function findList(id) {
  return state.lists.find((list) => list.id === id) || null;
}

function openSubtaskCount(uid) {
  return descendantsOf(uid).filter((d) => {
    const task = findTask(d);
    return task && task.status !== "COMPLETED";
  }).length;
}

// Shared write path for single-task mutations: change state, then persist
// through the async API. render() happens at the caller, where the UI side
// effects (announcements, focus) belong.
function setState(next) {
  const uid = next.uid;
  state.tasks = state.tasks.map((task) =>
    task.uid === uid ? { ...next, lastModified: Date.now() } : task
  );
  TodoStorage.saveTask(next).catch(() => {});
}

async function addTask(summary, dueDate) {
  const trimmed = (summary || "").trim();
  if (trimmed === "") return null;

  const now = Date.now();
  const siblings = state.tasks.filter(
    (t) => t.listId === state.currentListId && t.parentUid === null
  ).length;

  const task = {
    uid: createUid(),
    summary: trimmed,
    description: "",
    due: normalizeDueDate(dueDate),
    status: "NEEDS-ACTION",
    completed: null,
    parentUid: null,
    listId: state.currentListId,
    order: siblings,
    created: now,
    lastModified: now,
  };

  state.tasks = [...state.tasks, task];
  await TodoStorage.saveTask(task);
  announce('Added "' + task.summary + '"');
  render();
  return task;
}

async function toggleTask(uid) {
  const target = findTask(uid);
  if (!target) return;

  if (target.status === "COMPLETED") {
    // Unchecking never asks questions: it re-opens THIS task only; its
    // subtasks stay exactly as they were.
    setState({ ...target, status: "NEEDS-ACTION", completed: null });
    render();
    return;
  }

  if (openSubtaskCount(uid) > 0) {
    // Finishing a parent with open subtasks is where work quietly vanishes,
    // so the app asks first — inline card, no browser dialog.
    ui.pendingPrompt = { uid: uid, openCount: openSubtaskCount(uid) };
    render();
    return;
  }

  await completeTask(uid);
}

async function completeTask(uid) {
  const target = findTask(uid);
  if (!target || target.status === "COMPLETED") return;
  const now = Date.now();
  state.tasks = state.tasks.map((task) =>
    task.uid === uid
      ? { ...task, status: "COMPLETED", completed: now, lastModified: now }
      : task
  );
  await TodoStorage.saveTask(findTask(uid));
  render();
}

// The "Complete all" answer to the prompt: the whole subtree finishes.
async function completeTaskAndSubtree(uid) {
  const target = findTask(uid);
  if (!target) {
    ui.pendingPrompt = null;
    render();
    return;
  }
  const uids = subtreeUids(uid);
  const now = Date.now();
  state.tasks = state.tasks.map((task) =>
    uids.includes(task.uid)
      ? { ...task, status: "COMPLETED", completed: now, lastModified: now }
      : task
  );
  for (const u of uids) {
    const t = findTask(u);
    if (t) await TodoStorage.saveTask(t);
  }
  ui.pendingPrompt = null;
  announce(
    'Completed "' + target.summary + '" and its ' +
      (uids.length - 1) + " subtask" + (uids.length - 1 === 1 ? "" : "s")
  );
  render();
}

// The "Keep separate" answer: just the parent finishes.
function completePromptKeepSeparate() {
  const prompt = ui.pendingPrompt;
  ui.pendingPrompt = null;
  if (prompt) completeTask(prompt.uid);
  else render();
}

function cancelCompletePrompt() {
  ui.pendingPrompt = null;
  render();
}

async function deleteTask(uid) {
  const target = findTask(uid);
  // A task's whole subtree goes with it: a subtask that lost its parent has
  // no meaning, so deleting the parent takes all of it.
  const doomed = subtreeUids(uid);
  state.tasks = state.tasks.filter((task) => !doomed.includes(task.uid));
  for (const u of doomed) await TodoStorage.deleteTask(u);

  if (ui.editingId === uid || doomed.includes(ui.editingId)) {
    ui.editingId = null;
    ui.draft = "";
    ui.draftDue = null;
  }
  if (ui.detailsUid === uid || doomed.includes(ui.detailsUid)) {
    ui.detailsUid = null;
  }
  if (target) announce('Deleted "' + target.summary + '"');
  render();
}

/* ---------- editing (two-step, like iteration 2) ---------- */

function beginEdit(uid) {
  const task = findTask(uid);
  if (!task) return;
  ui.editingId = uid;
  ui.draft = task.summary;
  ui.draftDue = task.due;
  render();
  focusEditBox();
}

async function commitEdit() {
  if (ui.editingId === null) return;

  const uid = ui.editingId;
  const trimmed = ui.draft.trim();
  const nextDue = normalizeDueDate(ui.draftDue);
  const before = findTask(uid);
  ui.editingId = null;
  ui.draft = "";
  ui.draftDue = null;

  if (!before) {
    render();
    refocusAddInput();
    return;
  }

  // Empty text is not a valid task: clearing a task's text is plainly a
  // deletion (iteration-2 rule), which now takes the subtree with it.
  if (trimmed === "") {
    deleteTask(uid);
    return;
  }

  const changed = before.summary !== trimmed || before.due !== nextDue;
  setState({ ...before, summary: trimmed, due: nextDue });

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

/* ---------- subtasks: add / indent / outdent / collapse ---------- */

async function addSubtask(parentUid, summary) {
  const parent = findTask(parentUid);
  const trimmed = (summary || "").trim();
  if (!parent || trimmed === "") return null;

  const now = Date.now();
  const siblings = childrenOf(parentUid);
  const task = {
    uid: createUid(),
    summary: trimmed,
    description: "",
    due: null,
    status: "NEEDS-ACTION",
    completed: null,
    parentUid: parentUid,
    listId: parent.listId, // subtasks follow their parent's list
    order: siblings.length,
    created: now,
    lastModified: now,
  };

  state.tasks = [...state.tasks, task];
  await TodoStorage.saveTask(task);
  render();
  return task;
}

// indent: a top-level task becomes the last child of the top-level task above
// it. The whole subtree moves along and keeps its relative order.
async function indentTask(uid) {
  const target = findTask(uid);
  if (!target || target.parentUid !== null) return; // only top level indents

  const tops = topLevelTasks(target.listId);
  const index = tops.findIndex((t) => t.uid === uid);
  if (index <= 0) return; // first row has nothing to indent under

  const newParent = tops[index - 1];
  const uids = subtreeUids(uid);
  const now = Date.now();
  const existingChildren = childrenOf(newParent.uid).length;
  // `subOrder` = position within the moving subtree (parent first), which is
  // exactly the order the block gets under its new parent.
  const subOrder = new Map(uids.map((u, i) => [u, i]));

  state.tasks = state.tasks.map((task) => {
    if (task.uid === uid) {
      return {
        ...task,
        parentUid: newParent.uid,
        order: existingChildren + subOrder.get(task.uid),
        lastModified: now,
      };
    }
    if (task.parentUid === uid) {
      return {
        ...task,
        parentUid: newParent.uid,
        order: existingChildren + subOrder.get(task.uid),
        lastModified: now,
      };
    }
    return task;
  });

  for (const u of uids) {
    const t = findTask(u);
    if (t) await TodoStorage.saveTask(t);
  }
  render();
}

// outdent: a child becomes top-level, sitting just below its parent's slot.
async function outdentTask(uid) {
  const target = findTask(uid);
  if (!target || target.parentUid === null) return; // already top level

  const uids = subtreeUids(uid);
  const now = Date.now();
  const tops = topLevelTasks(target.listId);
  const parentIndex = tops.findIndex((t) => t.uid === target.parentUid);

  state.tasks = state.tasks.map((task) => {
    if (task.uid === uid) {
      const order = parentIndex === -1 ? tops.length : parentIndex + 1;
      return { ...task, parentUid: null, order: order, lastModified: now };
    }
    if (task.parentUid === uid) {
      return { ...task, order: uids.indexOf(task.uid), lastModified: now };
    }
    return task;
  });

  for (const u of uids) {
    const t = findTask(u);
    if (t) await TodoStorage.saveTask(t);
  }
  render();
}

function toggleCollapse(uid) {
  const task = findTask(uid);
  if (!task || childrenOf(uid).length === 0) return;
  if (ui.collapsed.has(uid)) ui.collapsed.delete(uid);
  else ui.collapsed.add(uid);
  render();
}

/* ---------- lists: create / rename / recolor / delete / switch ---------- */

function nextListColor() {
  const used = new Set(state.lists.map((l) => l.color));
  for (const color of LIST_COLORS) {
    if (!used.has(color)) return color;
  }
  return LIST_COLORS[state.lists.length % LIST_COLORS.length];
}

async function createList(name) {
  const trimmed = (name || "").trim();
  if (trimmed === "") return null;

  const list = {
    id: createUid(),
    name: trimmed,
    color: ui.listDraftColor || nextListColor(),
    order: state.lists.length,
  };

  state.lists = [...state.lists, list];
  await TodoStorage.saveList(list);
  state.currentListId = list.id;
  ui.listDraftColor = null;
  announce('Created list "' + list.name + '"');
  render();
  return list;
}

async function renameList(id, name) {
  const list = findList(id);
  const trimmed = (name || "").trim();
  if (!list || trimmed === "") return;

  const next = { ...list, name: trimmed };
  state.lists = state.lists.map((l) => (l.id === id ? next : l));
  await TodoStorage.saveList(next);
  announce('Renamed list "' + trimmed + '"');
  render();
}

async function recolorList(id, color) {
  const list = findList(id);
  if (!list || !/^#[0-9a-fA-F]{6}$/.test(color || "")) return;

  const next = { ...list, color: color };
  state.lists = state.lists.map((l) => (l.id === id ? next : l));
  await TodoStorage.saveList(next);
  render();
}

async function deleteList(id) {
  const list = findList(id);
  if (!list) return;
  if (list.id === "list-default") return; // "My Tasks" may never be deleted

  ui.listMenuId = null; // close the confirm card before the render below

  // A list is a CalDAV calendar: deleting it removes its tasks with it.
  const doomed = state.tasks
    .filter((task) => task.listId === id)
    .map((task) => task.uid);
  state.tasks = state.tasks.filter((task) => task.listId !== id);
  state.lists = state.lists.filter((l) => l.id !== id);

  for (const u of doomed) await TodoStorage.deleteTask(u);
  await TodoStorage.deleteList(id);

  // A task being moved or deleted while its details panel is open would
  // leave the panel showing a task that no longer exists — clear it here.
  if (doomed.includes(ui.detailsUid)) ui.detailsUid = null;

  if (state.currentListId === id) state.currentListId = "list-default";
  announce('Deleted list "' + list.name + '"');
  render();
}

function switchList(id) {
  if (!findList(id) || id === state.currentListId) return;
  state.currentListId = id;
  ui.editingId = null;
  ui.draft = "";
  ui.draftDue = null;
  ui.detailsUid = null;
  ui.listMenuId = null;
  ui.collapsed.clear();
  ui.filter = "all";
  render();
}

function toggleSidebar() {
  ui.sidebarCollapsed = !ui.sidebarCollapsed;
  render();
}

/* ---------- details panel: notes, due date, move to another list ---------- */

function openDetails(uid) {
  if (!findTask(uid)) return;
  ui.detailsUid = uid;
  syncDetailDraft(uid);
  render();
}

function closeDetails() {
  ui.detailsUid = null;
  render();
}

// Draft state for the panel: a Save/Cancel round-trip must never rebuild the
// panel under the caret, so the inputs update this and only Save writes.
const detail = { notes: "", due: null };

function syncDetailDraft(uid) {
  const task = findTask(uid);
  detail.notes = task ? task.description : "";
  detail.due = task ? task.due : null;
}

function updateDetailNotes(value) {
  detail.notes = value;
}

function updateDetailDue(value) {
  detail.due = normalizeDueDate(value);
}

async function saveDetails(uid) {
  const task = findTask(uid);
  if (!task) return;
  const changed =
    task.description !== detail.notes || task.due !== detail.due;
  if (!changed) {
    render();
    return;
  }
  setState({ ...task, description: detail.notes, due: detail.due });
  announce("Details saved");
  render();
}

// Move a task — and its whole subtree — to another list.
async function moveTaskToList(uid, listId) {
  const task = findTask(uid);
  const target = findList(listId);
  if (!task || !target || task.listId === listId) return;

  const uids = subtreeUids(uid);
  const now = Date.now();
  state.tasks = state.tasks.map((t) =>
    uids.includes(t.uid) ? { ...t, listId: listId, lastModified: now } : t
  );

  for (const u of uids) {
    const t = findTask(u);
    if (t) await TodoStorage.saveTask(t);
  }
  announce('Moved "' + task.summary + '" to "' + target.name + '"');
  render();
}

/* ---------- filters + clear completed (iteration-2 behaviour, per list) ---- */

function clearCompleted() {
  const doomed = state.tasks.filter(
    (task) =>
      task.listId === state.currentListId && task.status === "COMPLETED"
  );
  if (doomed.length === 0) return;

  const uids = new Set(doomed.map((task) => task.uid));
  state.tasks = state.tasks.filter((task) => !uids.has(task.uid));
  doomed.forEach((task) => {
    TodoStorage.deleteTask(task.uid).catch(() => {});
  });

  if (uids.has(ui.editingId)) {
    ui.editingId = null;
    ui.draft = "";
    ui.draftDue = null;
  }
  if (uids.has(ui.detailsUid)) ui.detailsUid = null;
  announce(
    "Cleared " +
      doomed.length +
      " completed task" +
      (doomed.length === 1 ? "" : "s")
  );
  render();
}

/* ---------- 4. Derived queries ---------- */

// The rows this view actually shows: top-level tasks of the current list,
// with their children nested, honoring the filter and the collapse set.
// The result is FLAT (each entry carries its own depth) — one DOM pass, and
// the depth drives the indent.
function visibleTaskEntries() {
  const tops = topLevelTasks(state.currentListId);
  const out = [];

  const passFilter = (task) => {
    if (ui.filter === "active") return task.status !== "COMPLETED";
    if (ui.filter === "completed") return task.status === "COMPLETED";
    return true;
  };

  const visit = (task, depth) => {
    if (!passFilter(task)) return;
    out.push({ task: task, depth: depth });
    if (ui.collapsed.has(task.uid)) return; // hide the subtree, keep the parent
    const kids = childrenOf(task.uid).sort(byOrder);
    for (const kid of kids) visit(kid, depth + 1);
  };

  for (const task of tops) visit(task, 0);
  return out;
}

// "Tasks left" counts every still-open task in this list, subtasks included,
// but an open subtask whose parent is ALSO open is not double-counted: the
// parent stands in for its whole open subtree.
function remainingCount(listId) {
  let total = 0;
  for (const task of state.tasks) {
    if (task.listId !== listId || task.status === "COMPLETED") continue;
    // Walk up: if ANY ancestor is open, this open task hides behind it.
    let ancestor = findTask(task.parentUid);
    while (ancestor) {
      if (ancestor.status !== "COMPLETED") break;
      ancestor = findTask(ancestor.parentUid);
    }
    if (!ancestor) total += 1; // open, and no open ancestor -> it counts
  }
  return total;
}

// Incomplete AND strictly before today. "Due today" is NOT overdue.
function isOverdue(task) {
  return (
    task.status !== "COMPLETED" && task.due !== null && task.due < todayISO()
  );
}

function overdueCount(listId) {
  return state.tasks.filter(
    (task) => task.listId === listId && isOverdue(task)
  ).length;
}

function listTopCount(id) {
  return state.tasks.filter(
    (task) => task.listId === id && task.parentUid === null
  ).length;
}

/* ---------- 5. Rendering ---------- */

// render() always rebuilds from state. There is exactly one way the UI can
// look, and it is impossible for a mutator to "forget" one corner of the DOM.
// Focus is captured before the rebuild and restored after.
function render() {
  const focusKey = captureFocusKey();
  const detailKey = captureDetailKey();

  renderSidebar();
  renderDeleteListCard();
  renderHeader();
  renderTaskList();
  renderDetailPanel(detailKey);
  renderStats();
  renderControls();
  refreshDragLine();
  restoreFocus(focusKey);
}

function renderHeader() {
  els.sidebarToggle.setAttribute(
    "aria-label",
    ui.sidebarCollapsed ? "Expand list sidebar" : "Collapse list sidebar"
  );
  els.sidebarToggle.textContent = ui.sidebarCollapsed ? "»" : "«";
  els.app.classList.toggle("sidebar-collapsed", ui.sidebarCollapsed);
}

function renderSidebar() {
  const wrap = els.listItems;
  wrap.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const list of state.lists) {
    fragment.appendChild(buildListRow(list));
  }
  wrap.appendChild(fragment);
}

function buildListRow(list) {
  const item = document.createElement("li");
  item.className = "list-item";
  item.dataset.id = list.id;
  if (list.id === state.currentListId) item.classList.add("is-current");

  const swatch = document.createElement("span");
  swatch.className = "list-swatch";
  swatch.style.background = list.color;

  const name = document.createElement("span");
  name.className = "list-name";
  name.textContent = list.name;

  const badge = document.createElement("span");
  badge.className = "list-count";
  badge.textContent = String(listTopCount(list.id));

  item.append(swatch, name, badge);

  if (list.id !== "list-default") {
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "icon-btn list-rename";
    rename.dataset.action = "rename-list";
    rename.dataset.focusKey = "list-rename:" + list.id;
    rename.setAttribute(
      "aria-label",
      "Rename list " + JSON.stringify(list.name)
    );
    rename.textContent = "✎";

    const color = document.createElement("input");
    color.type = "color";
    color.className = "list-color";
    color.dataset.action = "color-list";
    color.dataset.focusKey = "list-color:" + list.id;
    color.value = list.color;
    color.setAttribute(
      "aria-label",
      "Recolour list " + JSON.stringify(list.name)
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn list-remove";
    remove.dataset.action = "delete-list";
    remove.dataset.focusKey = "list-delete:" + list.id;
    remove.setAttribute(
      "aria-label",
      "Delete list " + JSON.stringify(list.name)
    );
    remove.textContent = "✕";

    const actions = document.createElement("div");
    actions.className = "list-actions";
    actions.append(rename, color, remove);
    item.appendChild(actions);
  }

  item.addEventListener("click", (event) => {
    if (event.target.closest("button, input")) return;
    switchList(list.id);
  });

  item.addEventListener("change", (event) => {
    if (event.target.dataset.action === "color-list") {
      recolorList(list.id, event.target.value);
    }
  });

  item.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input")) return;
    beginRenameList(list.id);
  });

  return item;
}

function beginRenameList(id) {
  const list = findList(id);
  if (!list || id === "list-default") return;
  const item = els.listItems.querySelector('[data-id="' + id + '"]');
  if (!item) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "list-rename-input";
  input.value = list.name;
  input.dataset.action = "draft-list";
  input.dataset.focusKey = "list-rename-input:" + id;
  input.setAttribute("aria-label", "List name");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.dataset.action = "save-list";
  save.dataset.focusKey = "list-rename-save:" + id;
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.action = "cancel-list";
  cancel.dataset.focusKey = "list-rename-cancel:" + id;
  cancel.textContent = "Cancel";

  item.classList.add("is-renaming");
  item.append(input, save, cancel);
  input.focus();
  input.select();
}

function commitRenameList(id) {
  const input = els.listItems.querySelector(
    '[data-id="' + id + '"] .list-rename-input'
  );
  if (input) renameList(id, input.value);
  render();
}

/* ---------- the task rows ---------- */

function renderTaskList() {
  els.list.innerHTML = "";
  const entries = visibleTaskEntries();
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    fragment.appendChild(buildRow(entry.task, entry.depth));
  }
  els.list.appendChild(fragment);

  if (ui.pendingPrompt) {
    els.list.appendChild(buildCompletePromptCard());
  }

  renderEmptyState(entries.length);
}

function buildRow(task, depth) {
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.id = task.uid;
  li.dataset.depth = String(Math.min(depth, MAX_DEPTH));
  if (task.status === "COMPLETED") li.classList.add("done");
  if (ui.editingId === task.uid) return buildEditRow(li, task);
  if (ui.dragId === task.uid) li.classList.add("is-dragging");

  const kids = childrenOf(task.uid);

  if (kids.length > 0) {
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "task-collapse icon-btn";
    collapse.dataset.action = "collapse";
    collapse.dataset.focusKey = "collapse:" + task.uid;
    const openCount = kids.filter((k) => k.status !== "COMPLETED").length;
    collapse.textContent = ui.collapsed.has(task.uid) ? "▸" : "▾";
    collapse.setAttribute(
      "aria-label",
      (ui.collapsed.has(task.uid) ? "Expand " : "Collapse ") +
        task.summary +
        " (" +
        openCount +
        " open subtask" +
        (openCount === 1 ? "" : "s") +
        ")"
    );
    li.appendChild(collapse);
  } else {
    li.appendChild(buildGrip(task));
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-check";
  checkbox.id = "task-check-" + task.uid;
  checkbox.checked = task.status === "COMPLETED";
  checkbox.dataset.action = "toggle";
  checkbox.dataset.focusKey = "check:" + task.uid;
  checkbox.setAttribute(
    "aria-label",
    "Mark " + JSON.stringify(task.summary) + " complete"
  );

  const text = document.createElement("label");
  text.className = "task-text";
  text.htmlFor = checkbox.id;
  text.textContent = task.summary;
  text.title = "Tap to tick · ✎ to edit · + for a subtask";

  const main = document.createElement("div");
  main.className = "task-main";
  main.append(text, buildDueBadge(task));

  li.append(checkbox, main, buildActions(task));
  return li;
}

function buildEditRow(li, task) {
  li.classList.add("is-editing");

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "edit-text";
  textInput.value = ui.draft;
  textInput.dataset.action = "draft";
  textInput.dataset.focusKey = "edit-text:" + task.uid;
  textInput.setAttribute("aria-label", "Task text");

  const dueInput = document.createElement("input");
  dueInput.type = "date";
  dueInput.className = "edit-due";
  dueInput.value = ui.draftDue || "";
  dueInput.dataset.action = "draft-due";
  dueInput.dataset.focusKey = "edit-due:" + task.uid;
  dueInput.setAttribute("aria-label", "Due date");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.dataset.action = "save";
  save.dataset.focusKey = "save:" + task.uid;
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.action = "cancel";
  cancel.dataset.focusKey = "cancel:" + task.uid;
  cancel.textContent = "Cancel";

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
  grip.dataset.focusKey = "grip:" + task.uid;
  grip.setAttribute("role", "button");
  grip.setAttribute("tabindex", "0");
  grip.setAttribute(
    "aria-label",
    "Reorder " + JSON.stringify(task.summary) + ". Alt+Up or Alt+Down moves it."
  );
  grip.textContent = "⋮⋮";
  return grip;
}

function buildActions(task) {
  const wrap = document.createElement("div");
  wrap.className = "row-actions";

  const sub = document.createElement("button");
  sub.type = "button";
  sub.className = "icon-btn task-sub";
  sub.dataset.action = "add-sub";
  sub.dataset.focusKey = "add-sub:" + task.uid;
  sub.setAttribute(
    "aria-label",
    "Add a subtask under " + JSON.stringify(task.summary)
  );
  sub.textContent = "+";

  const indent = document.createElement("button");
  indent.type = "button";
  indent.className = "icon-btn task-indent";
  indent.dataset.action = "indent";
  indent.dataset.focusKey = "indent:" + task.uid;
  indent.setAttribute(
    "aria-label",
    "Indent " + JSON.stringify(task.summary)
  );
  indent.textContent = "→";

  const outdent = document.createElement("button");
  outdent.type = "button";
  outdent.className = "icon-btn task-outdent";
  outdent.dataset.action = "outdent";
  outdent.dataset.focusKey = "outdent:" + task.uid;
  outdent.setAttribute(
    "aria-label",
    "Outdent " + JSON.stringify(task.summary)
  );
  outdent.textContent = "←";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-btn task-edit";
  edit.dataset.action = "edit";
  edit.dataset.focusKey = "edit:" + task.uid;
  edit.setAttribute("aria-label", "Edit " + JSON.stringify(task.summary));
  edit.textContent = "✎";

  const details = document.createElement("button");
  details.type = "button";
  details.className = "icon-btn task-details";
  details.dataset.action = "details";
  details.dataset.focusKey = "details:" + task.uid;
  details.setAttribute(
    "aria-label",
    "Details for " + JSON.stringify(task.summary)
  );
  details.textContent = "i";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn task-delete";
  remove.dataset.action = "delete";
  remove.dataset.focusKey = "delete:" + task.uid;
  remove.setAttribute(
    "aria-label",
    "Delete " + JSON.stringify(task.summary)
  );
  remove.textContent = "✕";

  wrap.append(sub, indent, outdent, edit, details, remove);
  return wrap;
}

function buildCompletePromptCard() {
  const prompt = ui.pendingPrompt;
  const task = findTask(prompt.uid);
  const card = document.createElement("div");
  card.className = "complete-prompt";
  card.dataset.role = "complete-prompt";
  card.setAttribute("role", "group");
  card.setAttribute(
    "aria-label",
    "Complete subtasks of " + JSON.stringify(task.summary)
  );

  const question = document.createElement("p");
  question.className = "prompt-question";
  question.textContent =
    'Complete "' +
    task.summary +
    '"? Its ' +
    prompt.openCount +
    " open subtask" +
    (prompt.openCount === 1 ? " stays" : "s stay") +
    " open unless you finish them too.";

  const completeAll = document.createElement("button");
  completeAll.type = "button";
  completeAll.className = "btn primary";
  completeAll.dataset.action = "prompt-complete-all";
  completeAll.dataset.focusKey = "prompt-complete-all:" + prompt.uid;
  completeAll.textContent = "Complete all";

  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "btn ghost";
  keep.dataset.action = "prompt-keep";
  keep.dataset.focusKey = "prompt-keep:" + prompt.uid;
  keep.textContent = "Keep separate";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.action = "prompt-cancel";
  cancel.dataset.focusKey = "prompt-cancel:" + prompt.uid;
  cancel.textContent = "Cancel";

  card.append(question, completeAll, keep, cancel);
  return card;
}

/* ---------- due badge + details panel ---------- */

function buildDueBadge(task) {
  const badge = document.createElement("span");
  badge.className = "due";

  if (task.due === null) {
    badge.dataset.dueState = "none";
    badge.textContent = "";
    badge.setAttribute("aria-hidden", "true");
    return badge;
  }

  const overdue = isOverdue(task);
  badge.dataset.dueState = overdue
    ? "overdue"
    : task.status === "COMPLETED"
      ? "done"
      : "open";
  badge.textContent = formatDueLabel(task.due);
  badge.title = overdue
    ? "Overdue — was due " + task.due
    : "Due " + task.due;
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

function renderDetailPanel(captured) {
  const panel = els.detailPanel;
  if (ui.detailsUid === null || !findTask(ui.detailsUid)) {
    ui.detailsUid = null;
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const task = findTask(ui.detailsUid);
  panel.hidden = false;
  panel.innerHTML = "";
  panel.dataset.uid = task.uid;

  const title = document.createElement("h2");
  title.className = "detail-title";
  title.textContent = task.summary;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn detail-close";
  close.dataset.action = "close-details";
  close.dataset.focusKey = "detail-close:" + task.uid;
  close.setAttribute("aria-label", "Close details");
  close.textContent = "✕";

  const notes = document.createElement("textarea");
  notes.className = "detail-notes";
  notes.rows = 4;
  notes.placeholder = "Notes — anything that belongs to this task.";
  notes.value = detail.notes;
  notes.dataset.action = "detail-notes";
  notes.dataset.focusKey = "detail-notes:" + task.uid;
  notes.setAttribute("aria-label", "Notes");

  const dueLabel = document.createElement("label");
  dueLabel.className = "detail-field";
  const dueSpan = document.createElement("span");
  dueSpan.className = "due-label";
  dueSpan.textContent = "Due";
  const due = document.createElement("input");
  due.type = "date";
  due.className = "detail-due";
  due.value = detail.due || "";
  due.dataset.action = "detail-due";
  due.dataset.focusKey = "detail-due:" + task.uid;
  due.setAttribute("aria-label", "Due date");
  dueLabel.append(dueSpan, due);

  const listLabel = document.createElement("label");
  listLabel.className = "detail-field";
  const listSpan = document.createElement("span");
  listSpan.className = "due-label";
  listSpan.textContent = "List";
  const listSelect = document.createElement("select");
  listSelect.className = "detail-list";
  listSelect.dataset.action = "detail-list";
  listSelect.dataset.focusKey = "detail-list:" + task.uid;
  listSelect.setAttribute("aria-label", "List");
  for (const list of state.lists) {
    const option = document.createElement("option");
    option.value = list.id;
    option.textContent = list.name;
    if (list.id === task.listId) option.selected = true;
    listSelect.appendChild(option);
  }
  listLabel.append(listSpan, listSelect);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.dataset.action = "save-details";
  save.dataset.focusKey = "save-details:" + task.uid;
  save.textContent = "Save";

  panel.append(title, close, notes, dueLabel, listLabel, save);

  if (captured) {
    const target = panel.querySelector(
      '[data-focus-key="' + captured.key + '"]'
    );
    if (target) target.focus({ preventScroll: true });
  }
}

/* ---------- empty state + stats + controls ---------- */

function renderEmptyState(shownCount) {
  if (shownCount > 0) {
    els.empty.hidden = true;
    return;
  }
  els.empty.hidden = false;

  const listHasAnything = state.tasks.some(
    (task) => task.listId === state.currentListId
  );
  const message = listHasAnything
    ? ui.filter === "active"
      ? "No active tasks in this list — everything is checked off."
      : ui.filter === "completed"
        ? "Nothing completed here yet. Tick a task to see it."
        : "Nothing to show in this list."
    : "This list is empty. Add the first task above, or pick another list.";

  els.empty.textContent = message;
}

function renderStats() {
  const remaining = remainingCount(state.currentListId);
  els.count.textContent =
    remaining + " " + (remaining === 1 ? "task" : "tasks") + " left";

  const overdue = overdueCount(state.currentListId);
  els.overdue.hidden = overdue === 0;
  els.overdue.textContent =
    overdue + " overdue — catch up on the ones that slipped.";
}

function renderControls() {
  for (const button of els.filters.querySelectorAll("button")) {
    const isActive = button.dataset.filter === ui.filter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  const completed = state.tasks.filter(
    (task) =>
      task.listId === state.currentListId && task.status === "COMPLETED"
  ).length;
  els.clearCompleted.disabled = completed === 0;
  els.clearCompleted.textContent =
    completed === 0
      ? "Clear completed"
      : "Clear completed (" + completed + ")";
}

/* ---------- focus care ---------- */

// Every focusable control carries a data-focus-key. If a render happens while
// one of them has focus (cross-tab sync mid-edit, say), the caret goes back.
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

function captureDetailKey() {
  const active = document.activeElement;
  if (!active || !els.detailPanel || !els.detailPanel.contains(active)) {
    return null;
  }
  return { key: active.dataset.focusKey || null };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const target = els.list.querySelector(
    '[data-focus-key="' + snapshot.key + '"]'
  );
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

// Screen-reader channel: a rebuild that removes focus should at least
// announce what happened.
function announce(message) {
  els.announce.textContent = message;
}

/* ---------- 6. Event wiring ---------- */

/*
 * One click/change/input/keydown listener on the list, not one per row.
 * Rows are destroyed and recreated on every render, so per-row listeners
 * would either leak or silently detach. Handlers read data-action.
 */
let pendingTextEdit = null;
let lastPointerType = "";

// Reorder within the CURRENT list only (reorder is a per-list / per-
// CalDAV-collection concept). `draggedId` lands where `targetId` was (or
// just after it) — the shape a backend wants.
async function reorderTask(draggedId, targetId, placeAfter) {
  const dragged = findTask(draggedId);
  const target = findTask(targetId);
  if (
    !dragged ||
    !target ||
    draggedId === targetId ||
    dragged.listId !== state.currentListId ||
    target.listId !== state.currentListId
  )
    return;
  if (dragged.parentUid !== null || target.parentUid !== null) return; // top

  const now = Date.now();
  const tops = topLevelTasks(state.currentListId);
  const targetIndex = tops.findIndex((t) => t.uid === targetId);
  if (targetIndex === -1) return;

  const newOrder = placeAfter ? targetIndex + 1 : targetIndex;
  const uids = subtreeUids(draggedId);
  state.tasks = state.tasks.map((task) => {
    if (task.uid === draggedId) {
      return { ...task, order: newOrder, lastModified: now };
    }
    if (task.parentUid === draggedId) {
      return { ...task, order: uids.indexOf(task.uid), lastModified: now };
    }
    return task;
  });

  const moved = findTask(draggedId);
  await TodoStorage.saveTask(moved);
  announce("Reordered");
  render();
}

function wireListEvents() {
  els.list.addEventListener("click", (event) => {
    if (drag.suppressClick) {
      drag.suppressClick = false;
      return;
    }

    const textEl = event.target.closest
      ? event.target.closest(".task-text")
      : null;
    if (textEl && event.detail >= 2 && lastPointerType !== "touch") {
      // detail=2 is the double-click. On touch, quick double-taps are common
      // while ticking boxes, so a double-tap must keep doing nothing but tick.
      pendingTextEdit = textEl.closest("li.task").dataset.id;
    }

    const actionEl = event.target.closest("[data-action]");
    if (actionEl && handlePromptAction(actionEl)) return;
    if (!actionEl || !els.list.contains(actionEl)) return;

    const row = actionEl.closest("li.task");
    if (!row) return;
    const id = row.dataset.id;

    if (actionEl.dataset.action === "toggle" && pendingTextEdit === id) {
      pendingTextEdit = null;
      // The first click of the double-click already ticked the box. Flipping
      // it back before opening the editor is what makes "double-click to
      // edit" never silently change a task's completion state.
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
      case "add-sub":
        promptForSubtask(id);
        break;
      case "indent":
        indentTask(id);
        break;
      case "outdent":
        outdentTask(id);
        break;
      case "collapse":
        toggleCollapse(id);
        break;
      case "details":
        openDetails(id);
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
    if (event.target.dataset.action === "draft") {
      updateDraft(event.target.value);
    }
  });

  els.list.addEventListener("keydown", (event) => {
    if (event.target.closest('[data-role="complete-prompt"]')) return;

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

    // Keyboard reorder: pointer drag is unreachable without a mouse or
    // touch, and Alt+Arrows keeps a keyboard/screen-reader user in the game.
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const shown = visibleTaskEntries();
      const index = shown.findIndex(
        (entry) => entry.task.uid === row.dataset.id
      );
      const neighbour = shown[index + direction];
      if (!neighbour) return;

      const focusKey = event.target.dataset.focusKey;
      reorderTask(row.dataset.id, neighbour.task.uid, direction === 1);

      const refocused = els.list.querySelector(
        '[data-focus-key="' + focusKey + '"]'
      );
      if (refocused) refocused.focus({ preventScroll: true });
      return;
    }

    // i / o are the keyboard path for indent / outdent.
    if (event.key === "i" && event.shiftKey) {
      event.preventDefault();
      indentTask(row.dataset.id);
    } else if (event.key === "o") {
      event.preventDefault();
      outdentTask(row.dataset.id);
    }
  });
}

// The prompt card is a plain <div> in the list, not a row, so its buttons
// have no li.task ancestor. Returns true when the click was a prompt button.
function handlePromptAction(actionEl) {
  const prompt = els.list.querySelector('[data-role="complete-prompt"]');
  if (!prompt || !prompt.contains(actionEl)) return false;
  const uid = ui.pendingPrompt ? ui.pendingPrompt.uid : null;
  switch (actionEl.dataset.action) {
    case "prompt-complete-all":
      completeTaskAndSubtree(uid);
      return true;
    case "prompt-keep":
      completePromptKeepSeparate();
      return true;
    case "prompt-cancel":
      cancelCompletePrompt();
      return true;
  }
  return false;
}

// "Add subtask" on touch is a tap + type; a small inline box under the row
// keeps it in the flow instead of opening a browser prompt.
function promptForSubtask(parentUid) {
  const row = els.list.querySelector('li.task[data-id="' + parentUid + '"]');
  if (!row || row.nextElementSibling?.classList.contains("subtask-box")) {
    return;
  }

  const box = document.createElement("div");
  box.className = "subtask-box";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "subtask-input";
  input.placeholder = "New subtask";
  input.setAttribute("aria-label", "New subtask under " + findTask(parentUid).summary);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn primary";
  add.dataset.focusKey = "subtask-add:" + parentUid;
  add.textContent = "Add";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.focusKey = "subtask-cancel:" + parentUid;
  cancel.textContent = "Cancel";

  add.addEventListener("click", () => addSubtask(parentUid, input.value));
  cancel.addEventListener("click", () => render());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addSubtask(parentUid, input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      render();
    }
  });

  box.append(input, add, cancel);
  row.after(box);
  input.focus();
}

/* ---------- drag to reorder (pointer events, works with touch on iPad) ---------- */

/*
 * Deliberately NOT HTML5 drag-and-drop: dnd does not work on iOS/iPadOS
 * Safari at all, and it fights with re-rendering. Pointer events cover
 * mouse, pen and touch with a single code path. The grip is the only drag
 * handle, and it carries touch-action:none in CSS — that is what makes a
 * drag work on a tablet at all. This is the ONE place that touches the DOM
 * outside render(); it never changes state.
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
  const task = findTask(row.dataset.id);
  if (!task || task.parentUid !== null) return; // only top-level rows drag

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
  if (row.dataset.depth !== "0") return; // drop guides only between top rows

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
  line.style.top =
    (placeAfter ? rowRect.bottom : rowRect.top) - listRect.top + "px";
}

// Called at the end of every render() so the guide can never point at a row
// that no longer exists (another tab deleted it mid-drag).
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

  // A completed drag is followed by a synthetic click on the grip;
  // swallowing it stops a stray edit/toggle after the drop.
  if (commit && targetId && targetId !== draggedId) {
    drag.suppressClick = true;
    reorderTask(draggedId, targetId, placeAfter);
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

/* ---------- toolbar, sidebar, detail panel ---------- */

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

// The "✕ next to the date" affordance only makes sense while a date is set;
// a dead button next to an empty field is noise.
function syncClearDue() {
  els.clearDue.hidden = els.dueInput.value === "";
}

function wireDueField() {
  els.dueInput.addEventListener("input", syncClearDue);
  syncClearDue();
}

function wireSidebar() {
  els.sidebarToggle.addEventListener("click", toggleSidebar);

  els.newListForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const created = createList(els.newListInput.value);
    if (created) els.newListInput.value = "";
    else els.newListInput.focus();
  });

  els.listItems.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !els.listItems.contains(actionEl)) return;

    // The delete-confirm card is a div appended after the <li>, not inside
    // it, so its buttons have no li.list-item ancestor. Resolve the id via
    // data-focus-key instead (the card's buttons carry the list id in it).
    const fk = actionEl.dataset.focusKey || "";
    const listId = fk.includes(":")
      ? fk.slice(fk.indexOf(":") + 1)
      : null;
    const item = actionEl.closest("li.list-item");

    switch (actionEl.dataset.action) {
      case "rename-list":
        if (item) beginRenameList(item.dataset.id);
        break;
      case "save-list":
        if (item) commitRenameList(item.dataset.id);
        break;
      case "cancel-list":
        if (item) render();
        break;
      case "delete-list":
        if (item) beginDeleteListConfirm(item.dataset.id);
        break;
      case "delete-list-confirm":
        deleteList(listId);
        break;
      case "delete-list-cancel":
        ui.listMenuId = null;
        render();
        break;
    }
  });

  els.listItems.addEventListener("keydown", (event) => {
    const item = event.target.closest("li.list-item");
    if (!item) return;
    const id = item.dataset.id;
    if (event.target.dataset.action === "draft-list") {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRenameList(id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        ui.listMenuId = null;
        render();
      }
    }
  });
}

// Deleting a list is destructive for its tasks, so the card asks first — in
// page, never a browser dialog.
function beginDeleteListConfirm(id) {
  const list = findList(id);
  if (!list || id === "list-default") return;
  ui.listMenuId = id;
  render();
}

function renderDeleteListCard() {
  const item = ui.listMenuId
    ? els.listItems.querySelector('[data-id="' + ui.listMenuId + '"]')
    : null;
  if (!item) {
    ui.listMenuId = null;
    return;
  }
  const list = findList(ui.listMenuId);
  if (!list) return;

  const taskCount = state.tasks.filter(
    (task) => task.listId === list.id
  ).length;

  const card = document.createElement("div");
  card.className = "list-confirm";
  card.setAttribute("role", "group");
  card.setAttribute(
    "aria-label",
    "Confirm deleting list " + JSON.stringify(list.name)
  );

  const question = document.createElement("p");
  question.className = "confirm-question";
  question.textContent =
    'Delete "' +
    list.name +
    '"' +
    (taskCount > 0
      ? " and its " + taskCount + " task" + (taskCount === 1 ? "" : "s")
      : "") +
    "?";

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "btn danger";
  confirm.dataset.action = "delete-list-confirm";
  confirm.dataset.focusKey = "list-delete-confirm:" + list.id;
  confirm.textContent = "Delete list";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.action = "delete-list-cancel";
  cancel.dataset.focusKey = "list-delete-cancel:" + list.id;
  cancel.textContent = "Cancel";

  card.append(question, confirm, cancel);
  item.after(card);
}

function wireDetailPanel() {
  els.detailPanel.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !els.detailPanel.contains(actionEl)) return;
    const uid = els.detailPanel.dataset.uid;

    if (actionEl.dataset.action === "close-details") {
      closeDetails();
      return;
    }

    // The list select applies immediately (one clear action, and the
    // announcement tells you it happened); notes/due still need a Save.
    if (actionEl.dataset.action === "detail-list") {
      moveTaskToList(uid, actionEl.value);
      return;
    }

    if (actionEl.dataset.action === "save-details") {
      saveDetails(uid);
    }
  });

  els.detailPanel.addEventListener("input", (event) => {
    if (event.target.dataset.action === "detail-notes") {
      updateDetailNotes(event.target.value);
    } else if (event.target.dataset.action === "detail-due") {
      updateDetailDue(event.target.value);
    }
  });

  els.detailPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetails();
  });
}

/* ---------- other tabs ---------- */

// A storage event means another tab wrote the v3 blob. Re-reading through the
// same async API and re-rendering is all it takes — "state in, UI out".
function wireStorageSync() {
  window.addEventListener("storage", (event) => {
    if (event.key !== "todo.tasks.v3" || event.newValue === null) return;
    if (ui.dragId !== null) return; // never yank a row out from under a drag
    reloadFromStorage();
  });
}

async function reloadFromStorage() {
  const fresh = await TodoStorage.loadAll();
  state.tasks = fresh.tasks;
  state.lists = fresh.lists;
  if (!findList(state.currentListId)) state.currentListId = "list-default";
  if (ui.detailsUid && !findTask(ui.detailsUid)) ui.detailsUid = null;
  if (ui.editingId && !findTask(ui.editingId)) {
    ui.editingId = null;
    ui.draft = "";
    ui.draftDue = null;
  }
  render();
}

/* ---------- 7. Boot ---------- */

async function boot() {
  bindEls();

  const initial = await TodoStorage.loadAll();
  state.tasks = initial.tasks;
  state.lists = initial.lists;
  state.currentListId = "list-default";

  wireToolbar();
  wireDueField();
  wireListEvents();
  wireDragEvents();
  wireSidebar();
  wireDetailPanel();
  wireStorageSync();

  render();

  // "Overdue" is a function of the calendar day, so a list left open across
  // midnight must re-flag itself without a reload.
  let day = todayISO();
  setInterval(() => {
    const today = todayISO();
    if (today === day) return;
    day = today;
    render();
  }, 60000);
}

boot();


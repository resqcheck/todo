/* =============================================================
 * To-Do List — iteration 3
 * storage.js: the ONLY module allowed to touch localStorage.
 *
 * Contract (this is the part a network CalDAV backend later keeps):
 *   TodoStorage.loadAll()    -> Promise<{ tasks: [], lists: [] }>
 *   TodoStorage.saveTask(t)  -> Promise
 *   TodoStorage.deleteTask(uid) -> Promise
 *   TodoStorage.saveList(l)  -> Promise
 *   TodoStorage.deleteList(id)  -> Promise
 *
 * Every function is async and returns a Promise; the UI must `await` it and
 * must NEVER read or write localStorage itself. Today the internals are
 * localStorage under one versioned key; tomorrow they are CalDAV requests
 * and none of the calling code changes.
 *
 * Data model (maps 1:1 onto VTODO later):
 *   task: { uid, summary, description, due ("YYYY-MM-DD"|null),
 *           status ("NEEDS-ACTION"|"COMPLETED"), completed (ts|null),
 *           parentUid (null|uid), listId, order, created, lastModified }
 *   list: { id, name, color, order }
 *
 * Migration: v2 (todo.tasks.v2) and v1 (todo.tasks.v1) blobs are READ ONLY.
 * On first load after an iteration-2 install, their tasks are copied into
 * the v3 blob under the default "My Tasks" list, and the old blobs are left
 * exactly as they were — a downgrade to iteration 2 never loses data.
 * ============================================================= */

/* global TodoStorage */
(function () {
  "use strict";

  var STORAGE_KEY = "todo.tasks.v3";
  var LEGACY_KEY_V2 = "todo.tasks.v2";
  var LEGACY_KEY_V1 = "todo.tasks.v1";
  var DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  var HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

  var DEFAULT_LIST_ID = "list-default";

  var DEFAULT_LIST = {
    id: DEFAULT_LIST_ID,
    name: "My Tasks",
    color: "#0b57d0",
    order: 0,
  };

  /* ---------- availability + raw access (the only two places) ---------- */

  function storageUsable() {
    try {
      var probe = STORAGE_KEY + ".probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  }

  var available = storageUsable();

  function readKey(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeKey(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ---------- ids + dates ---------- */

  function createUid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "uid-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 10) + "-" +
      Math.random().toString(36).slice(2, 10);
  }

  function isValidUuidish(v) {
    return typeof v === "string" && v.length >= 8;
  }

  // Legacy ids (iteration 1/2) are shorter than a UUID — accept anything that
  // looks like a stable id so a migrated task keeps the id iteration 2 stored.
  function isValidId(v) {
    return typeof v === "string" && v.length >= 3;
  }

  /* ---------- normalising readers ---------- */

  function normalizeDue(value) {
    return typeof value === "string" && DUE_DATE_PATTERN.test(value)
      ? value
      : null;
  }

  function normalizeColor(value) {
    return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
      ? value
      : DEFAULT_LIST.color;
  }

  // Unknown or absent fields are tolerated on purpose: a future CalDAV record
  // (or a half-migrated one) gets its missing fields filled, and a junk
  // record returns null and is dropped rather than crashing the app.
  function normalizeTask(raw, fallbackOrder) {
    if (!raw || typeof raw !== "object") return null;

    var summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (summary === "") return null;

    var uid = isValidUuidish(raw.uid) ? raw.uid : createUid();
    var created = Number.isFinite(raw.created) ? raw.created : Date.now();
    var lastModified = Number.isFinite(raw.lastModified)
      ? raw.lastModified
      : created;

    var completed = null;
    if (raw.status === "COMPLETED") {
      completed = Number.isFinite(raw.completed) ? raw.completed : created;
    }

    return {
      uid: uid,
      summary: summary,
      description: typeof raw.description === "string" ? raw.description : "",
      due: normalizeDue(raw.due),
      status: raw.status === "COMPLETED" ? "COMPLETED" : "NEEDS-ACTION",
      completed: completed,
      parentUid: isValidId(raw.parentUid) ? raw.parentUid : null,
      listId: typeof raw.listId === "string" && raw.listId !== ""
        ? raw.listId
        : DEFAULT_LIST_ID,
      order: Number.isFinite(raw.order) ? raw.order : fallbackOrder,
      created: created,
      lastModified: lastModified,
    };
  }


  function normalizeList(raw, fallbackOrder) {
    if (!raw || typeof raw !== "object") return null;

    var name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "" && raw.id !== DEFAULT_LIST_ID) return null;

    var id = isValidUuidish(raw.id)
      ? raw.id
      : "list-" + createUid();

    return {
      id: id,
      name: name === "" ? "Untitled" : name,
      color: normalizeColor(raw.color),
      order: Number.isFinite(raw.order) ? raw.order : fallbackOrder,
    };
  }

  /* ---------- iteration 1 / 2 records -> v3 tasks ---------- */

  // An iteration-2 record ({ id, text, done, createdAt, dueDate, updatedAt })
  // or an iteration-1 one ({ id, text, done, createdAt }) loses nothing:
  // the old id becomes the uid (stable, so iteration-2 selectors keep
  // working), the array index becomes the order, and "My Tasks" becomes the
  // home list.
  function legacyToTask(raw, index) {
    if (!raw || typeof raw !== "object") return null;

    var summary = (typeof raw.text === "string" ? raw.text.trim() : "");
    if (summary === "") return null;

    var created = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
    var lastModified = Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : created;

    return {
      uid: isValidId(raw.id) ? raw.id : createUid(),
      summary: summary,
      description: "",
      due: normalizeDue(raw.dueDate !== undefined ? raw.dueDate : null),
      status: raw.done === true ? "COMPLETED" : "NEEDS-ACTION",
      completed: raw.done === true ? lastModified : null,
      parentUid: null,
      listId: DEFAULT_LIST_ID,
      order: index, // v2 stored order as array order; that order is user data
      created: created,
      lastModified: lastModified,
    };
  }

  function parseLegacyArray(rawText) {
    try {
      var parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed)) return [];
      var tasks = [];
      for (var i = 0; i < parsed.length; i++) {
        var t = legacyToTask(parsed[i], i);
        if (t) tasks.push(t);
      }
      return tasks;
    } catch (error) {
      return [];
    }
  }

  /* ---------- v3 blob read/write ---------- */

  function parseV3(rawText) {
    var blob = { tasks: [], lists: [] };
    try {
      var parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.tasks)) {
          blob.tasks = parsed.tasks
            .map(function (raw, i) { return normalizeTask(raw, i); })
            .filter(function (t) { return t !== null; });
        }
        if (Array.isArray(parsed.lists)) {
          blob.lists = parsed.lists
            .map(function (raw, i) { return normalizeList(raw, i); })
            .filter(function (l) { return l !== null; });
        }
      }
    } catch (error) {
      /* corrupt JSON: start clean instead of crashing */
    }

    // "My Tasks" always exists — the one list that may never be deleted.
    if (
      !blob.lists.some(function (l) { return l.id === DEFAULT_LIST_ID; })
    ) {
      blob.lists.unshift({
        id: DEFAULT_LIST_ID,
        name: DEFAULT_LIST.name,
        color: DEFAULT_LIST.color,
        order: 0,
      });
    }

    // Heal orphans: a parent or list that is missing gets the task promoted
    // to top level / re-homed in "My Tasks" so rendering can never dangle.
    var listIds = blob.lists
      .map(function (l) { return l.id; })
      .reduce(function (acc, id) { acc[id] = true; return acc; }, {});
    var uidSet = blob.tasks
      .map(function (t) { return t.uid; })
      .reduce(function (acc, uid) { acc[uid] = true; return acc; }, {});
    blob.tasks = blob.tasks.map(function (t) {
      if (!uidSet[t.parentUid]) t.parentUid = null;
      if (!listIds[t.listId]) t.listId = DEFAULT_LIST_ID;
      return t;
    });

    return blob;
  }

  // The v3 blob IS the whole world: a later network backend can replace this
  // entire function's body and every caller stays intact.
  function loadBlob() {
    var raw = readKey(STORAGE_KEY);
    if (raw !== null) return parseV3(raw);

    // Migration from an earlier install, in order of importance:
    //   - v2 wins if present (a returning iteration-2 user is never clobbered
    //     by older v1 data)
    //   - otherwise fall back to v1
    //   - the legacy blobs are left in place, so downgrading stays possible
    //     and a failed upgrade is never destructive.
    var legacy = readKey(LEGACY_KEY_V2) !== null
      ? LEGACY_KEY_V2
      : LEGACY_KEY_V1;
    var blob = parseV3("null");
    if (legacy !== null) {
      blob.tasks = parseLegacyArray(readKey(legacy));
    }
    persist(blob); // safe now, not on first mutation: close-the-tab safety
    return blob;
  }

  var inMemory = null;

  function persist(blob) {
    if (!available) return true;
    return writeKey(STORAGE_KEY, JSON.stringify(blob));
  }

  /* ---------- the public, Promise-only surface ---------- */

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var TodoStorage = {
    loadAll: function () {
      return Promise.resolve().then(function () {
        inMemory = loadBlob();
        return clone(inMemory);
      });
    },

    // Upsert one task. The caller owns the full record; storage only persists.
    saveTask: function (task) {
      return Promise.resolve().then(function () {
        if (!inMemory) inMemory = loadBlob();
        var clean = normalizeTask(task, inMemory.tasks.length);
        if (!clean) return;
        var index = -1;
        for (var i = 0; i < inMemory.tasks.length; i++) {
          if (inMemory.tasks[i].uid === clean.uid) { index = i; break; }
        }
        if (index === -1) inMemory.tasks.push(clean);
        else inMemory.tasks[index] = clean;
        persist(inMemory);
      });
    },

    deleteTask: function (uid) {
      return Promise.resolve().then(function () {
        if (!inMemory) inMemory = loadBlob();
        inMemory.tasks = inMemory.tasks.filter(function (t) {
          return t.uid !== uid;
        });
        persist(inMemory);
      });
    },

    // Upsert one list.
    saveList: function (list) {
      return Promise.resolve().then(function () {
        if (!inMemory) inMemory = loadBlob();
        var clean = normalizeList(list, inMemory.lists.length);
        if (!clean) return;
        var index = -1;
        for (var i = 0; i < inMemory.lists.length; i++) {
          if (inMemory.lists[i].id === clean.id) { index = i; break; }
        }
        if (index === -1) inMemory.lists.push(clean);
        else inMemory.lists[index] = clean;
        persist(inMemory);
      });
    },

    // Remove a list from storage. The caller decides what happens to its
    // tasks (and whether the default list may be touched at all — storage
    // alone does not know the "My Tasks always exists" policy).
    deleteList: function (id) {
      return Promise.resolve().then(function () {
        if (!inMemory) inMemory = loadBlob();
        inMemory.lists = inMemory.lists.filter(function (l) {
          return l.id !== id;
        });
        persist(inMemory);
      });
    },
  };

  window.TodoStorage = TodoStorage;
})();


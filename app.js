/* Conscientiousness System beta
   One schedule grid. Task and By Time reorder independently.
   Nothing is stored. A refresh clears the page. */

(function () {
  "use strict";

  var MAX_ROWS = 81;
  var DRAG_THRESHOLD = 8;
  var CAP_TEXT = "Schedules max out at 81 tasks.";

  var state = {
    rows: [{ task: "", time: "" }],
    pool: [],
    guidedStep: 0,
    poolSeq: 1
  };

  /* Answers live in memory for this page load only. The form fields hold
     them; this object is the same data kept aside so a return to Guided
     Setup can refill the fields if the form is ever rebuilt. */
  var memory = null;

  var drag = null;
  var suppressClick = false;

  var gridBody = document.getElementById("grid-body");
  var gridWrap = document.getElementById("grid-wrap");
  var poolEl = document.getElementById("pool");
  var poolList = document.getElementById("pool-list");
  var capMsg = document.getElementById("cap-msg");
  var guidedEl = document.getElementById("guided");
  var modeChoice = document.getElementById("mode-choice");

  function modDay(mins) {
    return ((mins % 1440) + 1440) % 1440;
  }

  function round5(mins) {
    return modDay(Math.round(mins / 5) * 5);
  }

  /* Bare hours are morning (7 -> 7:00 AM). 12 without a meridian is noon.
     13–23 and an explicit pm become afternoon. 24:00 is midnight. */
  function parseTime(input) {
    if (input == null) return null;
    var s = String(input).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^by[\s:-]+/, "");
    s = s.replace(/\./g, "");
    s = s.replace(/\s+/g, "");
    var mer = null;
    var merMatch = s.match(/(am|pm)$/);
    if (merMatch) {
      mer = merMatch[1];
      s = s.slice(0, -2);
    }
    var h;
    var m;
    if (/^\d{1,2}:\d{1,2}$/.test(s)) {
      var parts = s.split(":");
      h = Number(parts[0]);
      m = Number(parts[1]);
    } else if (/^\d{3,4}$/.test(s)) {
      if (s.length === 3) {
        h = Number(s.slice(0, 1));
        m = Number(s.slice(1));
      } else {
        h = Number(s.slice(0, 2));
        m = Number(s.slice(2));
      }
    } else if (/^\d{1,2}$/.test(s)) {
      h = Number(s);
      m = 0;
    } else {
      return null;
    }
    if (!isFinite(h) || !isFinite(m) || m < 0 || m > 59 || h < 0) return null;
    if (mer) {
      if (h < 1 || h > 12) return null;
      if (h === 12) h = 0;
      if (mer === "pm") h += 12;
    } else {
      if (h === 24 && m === 0) h = 0;
      if (h > 23) return null;
    }
    return h * 60 + m;
  }

  function formatBy(mins) {
    mins = modDay(mins);
    var h24 = Math.floor(mins / 60);
    var m = mins % 60;
    var ampm = h24 >= 12 ? "PM" : "AM";
    var h = h24 % 12;
    if (h === 0) h = 12;
    var mm = m < 10 ? "0" + m : String(m);
    return "By " + h + ":" + mm + " " + ampm;
  }

  function readClock(id, fallback) {
    var el = document.getElementById(id);
    if (!el || !el.value) return fallback;
    var parts = el.value.split(":");
    var h = Number(parts[0]);
    var m = Number(parts[1] || 0);
    if (!isFinite(h) || !isFinite(m)) return fallback;
    return modDay(h * 60 + m);
  }

  function readOptionalClock(id) {
    var el = document.getElementById(id);
    if (!el || !el.value) return null;
    return readClock(id, null);
  }

  function readCommute() {
    var el = document.getElementById("commute");
    if (!el || el.value.trim() === "") return 20;
    var n = Number(el.value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function gatherAnswers() {
    var days = [];
    var boxes = document.querySelectorAll('input[name="workday"]');
    for (var i = 0; i < boxes.length; i++) days.push(boxes[i].checked);
    var shower = document.querySelector('input[name="shower"]:checked');
    return {
      wake: readClock("wake", 6 * 60 + 30),
      bed: readClock("bed", 22 * 60 + 30),
      workDays: days,
      workStart: readClock("work-start", 9 * 60),
      workEnd: readClock("work-end", 17 * 60),
      commute: readCommute(),
      breakfast: readOptionalClock("breakfast"),
      lunch: readOptionalClock("lunch"),
      dinner: readOptionalClock("dinner"),
      shower: shower ? shower.value : "morning",
      pets: document.getElementById("extra-pets").checked,
      workout: document.getElementById("extra-workout").checked,
      school: document.getElementById("extra-school").checked,
      other: document.getElementById("extra-other").checked,
      otherText: document.getElementById("other-text").value
    };
  }

  function sleepMinutes(wake, bed) {
    return modDay(wake - bed);
  }

  function updateSleepNote() {
    var note = document.getElementById("sleep-note");
    var mins = sleepMinutes(readClock("wake", 6 * 60 + 30), readClock("bed", 22 * 60 + 30));
    note.hidden = mins >= 7 * 60;
  }

  function toggleOther() {
    var on = document.getElementById("extra-other").checked;
    document.getElementById("other-field").hidden = !on;
  }

  /* Suggestions follow the written formulas. Times are rounded to 5 minutes.
     When two land on the same minute, the later one moves forward 5 minutes
     until the time is free. Work arrival, departure, and the lunch midpoint
     are included only when at least one work day is checked.
     "School or kids" has no time formula, so it becomes an untimed chip. */
  function buildSuggestions(a) {
    var works = a.workDays.some(function (checked) { return checked; });
    var items = [];

    function add(task, mins) {
      items.push({
        task: task,
        mins: mins == null ? null : round5(mins),
        order: items.length
      });
    }

    add("Wake Up", a.wake);
    add("Start Winding Down", a.bed - 60);
    add("Go To Bed And Try To Sleep", a.bed);
    if (works) {
      add("Arrive At Work", a.workStart - 15);
      add("Get Off Work", a.workEnd);
      add("Leave For Work", a.workStart - 15 - a.commute);
    }
    add("Eat Breakfast", a.breakfast != null ? a.breakfast : a.wake + 60);
    if (a.lunch != null) add("Eat Lunch", a.lunch);
    else if (works) add("Eat Lunch", (a.workStart + a.workEnd) / 2);
    add("Eat Dinner", a.dinner != null ? a.dinner : a.bed - 180);
    add("Shower", a.shower === "night" ? a.bed - 90 : a.wake + 30);
    add("Brush Teeth", a.wake + 30);
    add("Brush Teeth", a.bed - 30);
    if (a.pets) {
      add("Feed And Walk Pets", a.wake + 15);
      add("Feed And Walk Pets", a.workEnd + 30);
    }
    if (a.workout) add("Work Out", a.workEnd + 60);

    var timed = items.filter(function (item) { return item.mins != null; });
    timed.sort(function (x, y) {
      var dx = modDay(x.mins - a.wake);
      var dy = modDay(y.mins - a.wake);
      if (dx !== dy) return dx - dy;
      return x.order - y.order;
    });

    var used = {};
    for (var i = 0; i < timed.length; i++) {
      var t = modDay(timed[i].mins);
      while (used[t]) t = modDay(t + 5);
      used[t] = true;
      timed[i].mins = t;
    }

    var pool = timed.map(function (item) {
      return { id: state.poolSeq++, task: item.task, time: formatBy(item.mins) };
    });
    if (a.school) {
      pool.push({ id: state.poolSeq++, task: "School Or Kids", time: "" });
    }
    if (a.other && String(a.otherText || "").trim()) {
      pool.push({ id: state.poolSeq++, task: String(a.otherText).trim(), time: "" });
    }
    return pool;
  }

  function showCap() {
    capMsg.textContent = CAP_TEXT;
  }

  function clearCap() {
    capMsg.textContent = "";
  }

  function renderRows() {
    gridBody.textContent = "";
    state.rows.forEach(function (row, index) {
      var tr = document.createElement("tr");
      tr.dataset.index = String(index);

      var delTd = document.createElement("td");
      delTd.className = "col-delete";
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "row-delete";
      delBtn.setAttribute("aria-label", "Delete row " + (index + 1));
      delBtn.textContent = "×";
      delTd.appendChild(delBtn);

      var taskTd = document.createElement("td");
      taskTd.className = "fn task-cell col-task";
      taskTd.dataset.col = "task";
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "drag-handle";
      handle.tabIndex = -1;
      handle.setAttribute("aria-label", "Reorder task in row " + (index + 1));
      handle.textContent = "⋮⋮";
      var taskEdit = document.createElement("div");
      taskEdit.className = "cell-edit";
      taskEdit.setAttribute("role", "textbox");
      taskEdit.setAttribute("aria-label", "Task, row " + (index + 1));
      taskEdit.tabIndex = 0;
      taskEdit.contentEditable = "true";
      taskEdit.spellcheck = false;
      taskEdit.setAttribute("enterkeyhint", "done");
      taskEdit.textContent = row.task;
      taskTd.appendChild(handle);
      taskTd.appendChild(taskEdit);

      var timeTd = document.createElement("td");
      timeTd.className = "fn col-time";
      timeTd.dataset.col = "time";
      var timeEdit = document.createElement("div");
      timeEdit.className = "cell-edit" + (row.time ? "" : " is-empty");
      timeEdit.setAttribute("role", "textbox");
      timeEdit.setAttribute("aria-label", "By time, row " + (index + 1));
      timeEdit.tabIndex = 0;
      timeEdit.contentEditable = "true";
      timeEdit.spellcheck = false;
      timeEdit.setAttribute("enterkeyhint", "done");
      timeEdit.dataset.placeholder = "By (time)";
      timeEdit.setAttribute("aria-placeholder", "By (time)");
      timeEdit.textContent = row.time;
      timeTd.appendChild(timeEdit);

      var statusTd = document.createElement("td");
      statusTd.className = "fn col-status";
      statusTd.setAttribute("aria-readonly", "true");
      var status = document.createElement("div");
      status.className = "cell-readonly";
      status.setAttribute("aria-label", "Status, row " + (index + 1));
      statusTd.appendChild(status);

      tr.appendChild(delTd);
      tr.appendChild(taskTd);
      tr.appendChild(timeTd);
      tr.appendChild(statusTd);
      gridBody.appendChild(tr);
    });
  }

  function renderPool() {
    poolList.textContent = "";
    if (!state.pool.length) {
      poolEl.hidden = true;
      return;
    }
    poolEl.hidden = false;
    state.pool.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "chip";
      li.dataset.id = String(item.id);
      var name = document.createElement("span");
      name.className = "chip-text";
      name.textContent = item.task;
      li.appendChild(name);
      if (item.time) {
        var time = document.createElement("span");
        time.className = "chip-time";
        time.textContent = item.time;
        li.appendChild(time);
      }
      var add = document.createElement("button");
      add.type = "button";
      add.className = "chip-add";
      add.setAttribute("aria-label", "Add " + item.task + " to the schedule");
      add.textContent = "+";
      li.appendChild(add);
      poolList.appendChild(li);
    });
  }

  function rowIndexOf(node) {
    var tr = node.closest("tr");
    return tr ? Number(tr.dataset.index) : -1;
  }

  function commitCell(cell) {
    var index = rowIndexOf(cell);
    if (index < 0 || !state.rows[index]) return;
    var col = cell.closest("td").dataset.col;
    if (col === "task") {
      var task = cell.textContent.replace(/\s+/g, " ").trim();
      state.rows[index].task = task;
      cell.textContent = task;
      return;
    }
    if (col === "time") {
      var raw = cell.textContent.replace(/\s+/g, " ").trim();
      var prev = state.rows[index].time;
      if (raw === "") {
        state.rows[index].time = "";
        cell.textContent = "";
        cell.classList.add("is-empty");
        return;
      }
      var parsed = parseTime(raw);
      if (parsed == null) {
        cell.textContent = prev;
        cell.classList.toggle("is-empty", prev === "");
        return;
      }
      var formatted = formatBy(parsed);
      state.rows[index].time = formatted;
      cell.textContent = formatted;
      cell.classList.remove("is-empty");
    }
  }

  function commitActive() {
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains("cell-edit")) {
      active.blur();
    }
  }

  function placeCaret(cell, atEnd) {
    var range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(atEnd);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function beginEdit(cell) {
    cell.focus();
    if (cell.closest("td").dataset.col === "time") {
      placeCaret(cell, false);
      var sel = window.getSelection();
      if (sel && cell.textContent) {
        var range = document.createRange();
        range.selectNodeContents(cell);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      placeCaret(cell, true);
    }
  }

  function moveColumn(col, from, to) {
    if (from === to || from < 0 || to < 0) return;
    if (from >= state.rows.length || to >= state.rows.length) return;
    var key = col === "time" ? "time" : "task";
    var values = state.rows.map(function (row) { return row[key]; });
    var moved = values.splice(from, 1)[0];
    values.splice(to, 0, moved);
    values.forEach(function (value, index) { state.rows[index][key] = value; });
  }

  function nextEmptyIndex() {
    for (var i = 0; i < state.rows.length; i++) {
      if (!state.rows[i].task.trim()) return i;
    }
    return -1;
  }

  function addSuggestionToGrid(id) {
    var idx = -1;
    for (var i = 0; i < state.pool.length; i++) {
      if (String(state.pool[i].id) === String(id)) { idx = i; break; }
    }
    if (idx < 0) return false;
    var suggestion = state.pool[idx];
    var rowIndex = nextEmptyIndex();
    if (rowIndex === -1) {
      if (state.rows.length >= MAX_ROWS) {
        showCap();
        return false;
      }
      state.rows.push({ task: "", time: "" });
      rowIndex = state.rows.length - 1;
    }
    state.rows[rowIndex].task = suggestion.task;
    state.rows[rowIndex].time = suggestion.time;
    state.pool.splice(idx, 1);
    clearCap();
    renderRows();
    renderPool();
    return true;
  }

  function addRow() {
    if (state.rows.length >= MAX_ROWS) {
      showCap();
      return;
    }
    clearCap();
    state.rows.push({ task: "", time: "" });
    renderRows();
    var last = gridBody.querySelector("tr:last-child td[data-col='task'] .cell-edit");
    if (last) last.focus();
  }

  function deleteRow(index) {
    if (index < 0 || index >= state.rows.length) return;
    state.rows.splice(index, 1);
    if (state.rows.length < MAX_ROWS) clearCap();
    renderRows();
  }

  function cleanupDrag() {
    document.body.classList.remove("is-dragging");
    if (drag && drag.ghost) drag.ghost.remove();
    var marked = document.querySelectorAll(".drop-target, .drop-col, .is-source, .is-dragging");
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove("drop-target", "drop-col", "is-source", "is-dragging");
    }
    if (gridWrap) gridWrap.classList.remove("chip-over");
    drag = null;
  }

  function makeGhost(text, x, y) {
    var ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = text;
    document.body.appendChild(ghost);
    moveGhost(ghost, x, y);
    return ghost;
  }

  function moveGhost(ghost, x, y) {
    ghost.style.left = Math.max(8, x + 12) + "px";
    ghost.style.top = Math.max(8, y + 12) + "px";
  }

  function rowIndexFromY(y) {
    var rows = gridBody.querySelectorAll("tr");
    if (!rows.length) return 0;
    for (var i = 0; i < rows.length; i++) {
      var rect = rows[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return rows.length - 1;
  }

  function markDrop(index, col) {
    var rows = gridBody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var on = i === index;
      rows[i].classList.toggle("drop-target", on);
      var cells = rows[i].querySelectorAll("td");
      for (var c = 0; c < cells.length; c++) cells[c].classList.remove("drop-col");
      if (on) {
        var target = rows[i].querySelector('td[data-col="' + col + '"]');
        if (target) target.classList.add("drop-col");
      }
    }
  }

  function highlightNextEmpty() {
    var index = nextEmptyIndex();
    var rows = gridBody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("drop-target", i === index);
    }
  }

  function pointOverGrid(x, y) {
    var under = document.elementFromPoint(x, y);
    return !!(under && under.closest && under.closest("#grid-wrap"));
  }

  function beginCellDrag(opts) {
    var cell = opts.cell;
    drag = {
      mode: "cell",
      phase: opts.immediate ? "dragging" : "armed",
      pointerId: opts.pointerId,
      startX: opts.x,
      startY: opts.y,
      column: opts.column,
      fromIndex: opts.index,
      overIndex: opts.index,
      cell: cell,
      ghost: null
    };
    if (opts.immediate) {
      document.body.classList.add("is-dragging");
      cell.classList.add("is-source");
      drag.ghost = makeGhost(cell.textContent || "Task", opts.x, opts.y);
      markDrop(opts.index, opts.column);
    }
    if (opts.captureEl && opts.captureEl.setPointerCapture) {
      try { opts.captureEl.setPointerCapture(opts.pointerId); } catch (err) { /* already released */ }
    }
  }

  function onGridPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    var handle = e.target.closest(".drag-handle");
    if (handle) {
      var handleCell = handle.parentNode.querySelector(".cell-edit");
      if (document.activeElement === handleCell) handleCell.blur();
      e.preventDefault();
      beginCellDrag({
        immediate: true,
        cell: handleCell,
        column: "task",
        index: rowIndexOf(handle),
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        captureEl: handle
      });
      return;
    }
    var cell = e.target.closest(".cell-edit");
    if (!cell || !gridBody.contains(cell)) return;
    var col = cell.closest("td").dataset.col;
    if (col !== "task" && col !== "time") return;
    if (e.pointerType === "touch") return;
    if (document.activeElement === cell) return;
    e.preventDefault();
    commitActive();
    beginCellDrag({
      immediate: false,
      cell: cell,
      column: col,
      index: rowIndexOf(cell),
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      captureEl: cell
    });
  }

  function onPoolPointerDown(e) {
    if (e.target.closest(".chip-add")) return;
    if (e.button != null && e.button !== 0) return;
    var chip = e.target.closest(".chip");
    if (!chip) return;
    drag = {
      mode: "chip",
      phase: "armed",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      chipId: chip.dataset.id,
      chip: chip,
      ghost: null,
      overGrid: false
    };
    try { chip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.phase === "armed") {
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      drag.phase = "dragging";
      document.body.classList.add("is-dragging");
      if (drag.mode === "cell") {
        drag.cell.classList.add("is-source");
        drag.ghost = makeGhost(drag.cell.textContent || "", e.clientX, e.clientY);
      } else {
        drag.chip.classList.add("is-dragging");
        drag.chip.style.pointerEvents = "none";
        var label = drag.chip.querySelector(".chip-text");
        drag.ghost = makeGhost(label ? label.textContent : "Suggestion", e.clientX, e.clientY);
      }
    }
    if (drag.phase !== "dragging") return;
    e.preventDefault();
    if (drag.ghost) moveGhost(drag.ghost, e.clientX, e.clientY);
    if (drag.mode === "cell") {
      drag.overIndex = rowIndexFromY(e.clientY);
      markDrop(drag.overIndex, drag.column);
    } else {
      drag.overGrid = pointOverGrid(e.clientX, e.clientY);
      gridWrap.classList.toggle("chip-over", drag.overGrid);
      if (drag.overGrid) highlightNextEmpty();
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var info = drag;
    var dragged = info.phase === "dragging";
    if (info.mode === "chip" && info.chip) info.chip.style.pointerEvents = "";
    cleanupDrag();
    if (!dragged && info.mode === "cell") {
      beginEdit(info.cell);
      return;
    }
    if (dragged) {
      // The gesture's click follows pointerup synchronously. Swallow that
      // click only, so the next real click still edits or adds a row.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      if (info.mode === "cell" && info.fromIndex !== info.overIndex) {
        moveColumn(info.column, info.fromIndex, info.overIndex);
        renderRows();
      }
      if (info.mode === "chip" && info.overGrid) {
        addSuggestionToGrid(info.chipId);
      }
    }
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.chip) drag.chip.style.pointerEvents = "";
    cleanupDrag();
  }

  function scrollToEl(el) {
    if (!el) return;
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function showDIY() {
    guidedEl.hidden = true;
    document.getElementById("diy-btn").setAttribute("aria-pressed", "true");
    document.getElementById("guided-btn").setAttribute("aria-pressed", "false");
    if (state.rows.length === 0) {
      state.rows.push({ task: "", time: "" });
      renderRows();
    }
    scrollToEl(document.getElementById("builder"));
    var first = gridBody.querySelector("td[data-col='task'] .cell-edit");
    if (first) first.focus();
  }

  function showStep(n) {
    var steps = guidedEl.querySelectorAll(".step");
    if (n < 0) n = 0;
    if (n > steps.length - 1) n = steps.length - 1;
    state.guidedStep = n;
    for (var i = 0; i < steps.length; i++) steps[i].hidden = i !== n;
    document.getElementById("back-btn").disabled = n === 0;
    document.getElementById("next-btn").textContent = "Next";
    document.getElementById("step-label").textContent = "Step " + (n + 1) + " of " + steps.length;
    updateSleepNote();
    var heading = steps[n].querySelector("h3");
    if (heading) heading.focus();
  }

  function showGuided() {
    document.getElementById("guided-btn").setAttribute("aria-pressed", "true");
    document.getElementById("diy-btn").setAttribute("aria-pressed", "false");
    guidedEl.hidden = false;
    if (memory) applyMemory(memory);
    showStep(state.guidedStep);
    scrollToEl(guidedEl);
  }

  function applyMemory(data) {
    function setTime(id, mins) {
      if (mins == null) {
        document.getElementById(id).value = "";
        return;
      }
      var h = Math.floor(modDay(mins) / 60);
      var m = modDay(mins) % 60;
      var hh = h < 10 ? "0" + h : String(h);
      var mm = m < 10 ? "0" + m : String(m);
      document.getElementById(id).value = hh + ":" + mm;
    }
    setTime("wake", data.wake);
    setTime("bed", data.bed);
    setTime("work-start", data.workStart);
    setTime("work-end", data.workEnd);
    setTime("breakfast", data.breakfast);
    setTime("lunch", data.lunch);
    setTime("dinner", data.dinner);
    document.getElementById("commute").value = String(data.commute);
    var boxes = document.querySelectorAll('input[name="workday"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = !!data.workDays[i];
    var shower = document.querySelector('input[name="shower"][value="' + data.shower + '"]');
    if (shower) shower.checked = true;
    document.getElementById("extra-pets").checked = !!data.pets;
    document.getElementById("extra-workout").checked = !!data.workout;
    document.getElementById("extra-school").checked = !!data.school;
    document.getElementById("extra-other").checked = !!data.other;
    document.getElementById("other-text").value = data.otherText || "";
    toggleOther();
    updateSleepNote();
  }

  function remember() {
    memory = gatherAnswers();
  }

  function restoreRequiredClocks() {
    var defaults = { wake: "06:30", bed: "22:30", "work-start": "09:00", "work-end": "17:00" };
    Object.keys(defaults).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) el.value = defaults[id];
    });
    var commute = document.getElementById("commute");
    if (commute && commute.value.trim() === "") commute.value = "20";
  }

  function onNext() {
    restoreRequiredClocks();
    remember();
    var steps = guidedEl.querySelectorAll(".step");
    if (state.guidedStep >= steps.length - 1) {
      state.pool = buildSuggestions(gatherAnswers());
      state.guidedStep = 0;
      guidedEl.hidden = true;
      renderPool();
      scrollToEl(poolEl.hidden ? document.getElementById("builder") : poolEl);
      return;
    }
    showStep(state.guidedStep + 1);
  }

  function onBack() {
    remember();
    if (state.guidedStep > 0) showStep(state.guidedStep - 1);
  }

  function wire() {
    document.getElementById("start-btn").addEventListener("click", function () {
      modeChoice.hidden = false;
      scrollToEl(modeChoice);
      document.getElementById("mode-heading").setAttribute("tabindex", "-1");
      document.getElementById("mode-heading").focus();
    });

    document.getElementById("diy-btn").addEventListener("click", showDIY);
    document.getElementById("guided-btn").addEventListener("click", showGuided);
    document.getElementById("skip-btn").addEventListener("click", function () {
      remember();
      showDIY();
    });
    document.getElementById("back-btn").addEventListener("click", onBack);
    document.getElementById("next-btn").addEventListener("click", onNext);
    document.getElementById("guided-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onNext();
    });

    function onGuidedFieldChanged() {
      remember();
      updateSleepNote();
      toggleOther();
    }
    guidedEl.addEventListener("input", onGuidedFieldChanged);
    guidedEl.addEventListener("change", onGuidedFieldChanged);

    var skips = document.querySelectorAll(".meal-skip");
    for (var i = 0; i < skips.length; i++) {
      skips[i].addEventListener("click", function (e) {
        var id = e.currentTarget.getAttribute("data-for");
        document.getElementById(id).value = "";
        remember();
      });
    }

    document.getElementById("add-row").addEventListener("click", function () {
      commitActive();
      addRow();
    });

    gridBody.addEventListener("click", function (e) {
      var btn = e.target.closest(".row-delete");
      if (!btn) return;
      deleteRow(rowIndexOf(btn));
    });

    gridBody.addEventListener("focusout", function (e) {
      var cell = e.target.closest && e.target.closest(".cell-edit");
      if (!cell || !gridBody.contains(cell)) return;
      commitCell(cell);
    });

    gridBody.addEventListener("input", function (e) {
      var cell = e.target.closest && e.target.closest(".cell-edit");
      if (!cell) return;
      var col = cell.closest("td").dataset.col;
      var index = rowIndexOf(cell);
      if (index < 0) return;
      if (col === "task") {
        state.rows[index].task = cell.textContent.replace(/\u00a0/g, " ");
      }
      if (col === "time") {
        cell.classList.toggle("is-empty", cell.textContent.trim() === "");
      }
    });

    gridBody.addEventListener("keydown", function (e) {
      var cell = e.target.closest && e.target.closest(".cell-edit");
      if (!cell) return;
      if (e.key === "Enter") {
        e.preventDefault();
        cell.blur();
      }
    });

    gridBody.addEventListener("paste", function (e) {
      var cell = e.target.closest && e.target.closest(".cell-edit");
      if (!cell) return;
      e.preventDefault();
      var clip = e.clipboardData || window.clipboardData;
      var text = String(clip ? clip.getData("text") : "").replace(/\s+/g, " ").trim();
      var sel = window.getSelection();
      if (sel && sel.rangeCount && cell.contains(sel.anchorNode)) {
        var range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
      } else {
        cell.textContent = (cell.textContent + " " + text).trim();
      }
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    });

    gridBody.addEventListener("pointerdown", onGridPointerDown);
    poolList.addEventListener("pointerdown", onPoolPointerDown);
    poolList.addEventListener("click", function (e) {
      var btn = e.target.closest(".chip-add");
      if (!btn) return;
      addSuggestionToGrid(btn.closest(".chip").dataset.id);
    });

    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);

    document.addEventListener("click", function (e) {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drag) {
        if (drag.chip) drag.chip.style.pointerEvents = "";
        cleanupDrag();
      }
    });

    document.getElementById("grid").addEventListener("keydown", function (e) {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      var cell = e.target.closest && e.target.closest(".cell-edit");
      if (!cell) return;
      e.preventDefault();
      commitCell(cell);
      var index = rowIndexOf(cell);
      var col = cell.closest("td").dataset.col;
      var target = index + (e.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= state.rows.length) return;
      moveColumn(col, index, target);
      renderRows();
      var moved = gridBody.querySelector('tr[data-index="' + target + '"] td[data-col="' + col + '"] .cell-edit');
      if (moved) moved.focus();
    });
  }

  renderRows();
  wire();
  updateSleepNote();
  toggleOther();
  remember();

  window.CS = {
    parseTime: parseTime,
    formatBy: formatBy,
    round5: round5,
    buildSuggestions: buildSuggestions,
    gatherAnswers: gatherAnswers,
    getState: function () { return state; }
  };
})();

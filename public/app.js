// Shared client helpers. Deliberately no framework: the whole point of this
// tool is that it costs nothing to run and nothing to rebuild.
window.WB = (function () {
  // Order matters: this is the order the filter row and the status dropdown
  // present, and it runs live → parked → done.
  const STATUS_LABELS = {
    'needs-decision': 'Decision',
    'needs-qa': 'QA',
    received: 'Received',
    'in-progress': 'Working',
    // Committed work waiting on something that is not a decision: a deploy,
    // another item, a merge. It WILL be done — unlike deferred, which is
    // parked on purpose and may never come back.
    'blocked': 'Blocked',
    // A to-do's open state, on a to-do project only (contract v18).
    todo: 'To do',
    'deferred': 'Deferred',
    active: 'Active',
    archived: 'Archived',
    complete: 'Complete',
    // An issue decided against. Finished as far as the board is concerned.
    cancelled: 'Cancelled',
  };

  // Not tasks. A document is either the current reference or it has been
  // superseded; it is never waiting on anybody and never finished.
  const DOCUMENT_STATUSES = ['active', 'archived'];
  // A to-do's set: its own open state plus the parked and finished ones it
  // shares with an issue. Mirrors TODO_STATUSES in src/db.ts.
  const TODO_STATUSES = ['todo', 'deferred', 'complete', 'cancelled'];
  const ISSUE_STATUSES = Object.keys(STATUS_LABELS).filter((s) => DOCUMENT_STATUSES.indexOf(s) === -1 && s !== 'todo');

  // The statuses an item may hold, by what it IS. Issue and document do not
  // overlap: offering all seven let a specification be set to "Received",
  // which is the exact confusion the split exists to prevent. A to-do never
  // offers the whose-move states either.
  function statusesFor(kind) {
    return kind === 'document' ? DOCUMENT_STATUSES : kind === 'todo' ? TODO_STATUSES : ISSUE_STATUSES;
  }

  // An issue and a question set are both the handshake: something to decide or
  // do, held at a whose-move status. Mirrors isWorkKind in src/db.ts, so the
  // pages ask one question where they used to test kind === 'issue'.
  function isWork(kind) {
    return kind === 'issue' || kind === 'questions';
  }

  // Statuses that mean the human owes something. The index card counts these
  // together, because "how much is on me" is one number to a person even though
  // the two asks are different in kind.
  const WAITING_ON_YOU = ['needs-decision', 'needs-qa'];

  // QA is not all theirs: a step can belong to an agent. The server derives
  // `qa` (the make-up of the steps) and `qaWaitingOn` (who has open steps);
  // these only present them, so a row, a filter and a count cannot disagree.
  const QA_LABELS = { human: 'Human QA', agent: 'Agent QA', mixed: 'Mixed QA' };
  function qaChip(item) {
    if (!item || item.status !== 'needs-qa' || !QA_LABELS[item.qa]) return null;
    const el = document.createElement('span');
    el.className = 'qa-chip qa-' + item.qa;
    el.textContent = QA_LABELS[item.qa];
    if (item.qa === 'mixed' && item.qaWaitingOn) el.title = 'Open steps wait on the ' + (item.qaWaitingOn === 'agent' ? 'agent' : 'person');
    return el;
  }
  // Decisions plus QA, less the QA only an agent has left to run.
  function waitingOnYou(counts, qaCounts) {
    const all = WAITING_ON_YOU.reduce((n, k) => n + ((counts && counts[k]) || 0), 0);
    return all - ((qaCounts && qaCounts.waitingOnAgent) || 0);
  }

  async function req(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: 'server sent a response that was not JSON' };
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data && data.error ? data.error : method + ' ' + path + ' failed (' + res.status + ')');
    }
    return data;
  }

  // The year appears only when it is not this one. A board read in January
  // otherwise shows "Dec 3" for something raised thirteen months ago and reads
  // as last week.
  function fmt(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      return d.toLocaleString(undefined, opts);
    } catch {
      return '';
    }
  }

  // Offer the labels already in use to a comma-separated label field: as
  // datalist options (so typing completes to the existing spelling) and as
  // click-to-add chips beneath it. Exists because a label typed from memory is
  // how "Deploys" ends up beside "Deploy": both lists then look complete and a
  // filter on either misses half the work. `labels` is the [{name, count}]
  // the API returns with the board and from GET /api/projects/<slug>/labels.
  function labelChoices(labels, datalist, picks, input) {
    if (datalist) {
      datalist.innerHTML = '';
      for (const l of labels) {
        const o = document.createElement('option');
        o.value = l.name;
        datalist.appendChild(o);
      }
    }
    if (!picks || !input) return;
    picks.innerHTML = '';
    const current = () => input.value.split(',').map((s) => s.trim()).filter(Boolean);
    for (const l of labels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lr-label mono pick';
      b.textContent = l.name;
      b.title = l.count === 1 ? '1 item carries this label' : l.count + ' items carry this label';
      const sync = () => b.classList.toggle('on', current().some((c) => c.toLowerCase() === l.name.toLowerCase()));
      b.addEventListener('click', () => {
        const have = current();
        const idx = have.findIndex((c) => c.toLowerCase() === l.name.toLowerCase());
        if (idx >= 0) have.splice(idx, 1); else have.push(l.name);
        input.value = have.join(', ');
        sync();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      input.addEventListener('input', sync);
      sync();
      picks.appendChild(b);
    }
  }

  // PATCHes for one key (an item id) go one at a time, in the order asked, so
  // a slow earlier response can never land after a later one. Different keys
  // do not wait for each other. A failed save does not block the next.
  const saveQueues = {};
  function serialPatch(key, path, body) {
    const prev = saveQueues[key] || Promise.resolve();
    const next = prev.catch(() => {}).then(() => req('PATCH', path, body));
    saveQueues[key] = next;
    return next;
  }

  // Copy `ref` onto the clipboard, with feedback either way. Wrapped so a
  // denied permission or an insecure context (clipboard APIs need HTTPS or
  // localhost) never throws out of a click handler — it falls back to
  // selecting the chip's own text so the person can still copy it by hand.
  async function copyRef(chip, ref) {
    try {
      await navigator.clipboard.writeText(ref);
    } catch (err) {
      try {
        const range = document.createRange();
        range.selectNodeContents(chip);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (selErr) { /* nothing left to try; the chip still shows the ref */ }
      chip.title = 'Copy failed — text selected';
      return;
    }
    const original = chip.textContent;
    chip.classList.add('copied');
    chip.textContent = 'Copied';
    setTimeout(() => {
      chip.classList.remove('copied');
      chip.textContent = original;
    }, 1200);
  }

  // The chip a person quotes elsewhere — clicking it copies the reference.
  // Returns null (never an empty element) when the project has no key, so a
  // caller can skip appending it instead of rendering nothing.
  function refChip(ref) {
    if (!ref) return null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ref-chip mono';
    chip.textContent = ref;
    chip.title = 'Copy reference';
    chip.setAttribute('aria-label', 'Copy reference ' + ref);
    chip.addEventListener('click', (e) => {
      // A chip beside a card's own link must never trigger that link's
      // navigation — copying the reference is the whole point of clicking it.
      e.preventDefault();
      e.stopPropagation();
      copyRef(chip, ref);
    });
    return chip;
  }

  // A ref inside free text (WB-DEMO-14) linked, but only when its key matches
  // THIS project's — the whole point of "resolves on this board". Anything
  // else, including a ref that merely looks like one, stays plain text next to
  // it: text nodes only, so nothing in `text` is ever parsed as markup.
  const REF_IN_TEXT = /\bWB-([A-Z][A-Z0-9]{1,4})-([1-9][0-9]*)\b/gi;
  function renderBlockedBy(text, slug, projectKey) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;
    const re = new RegExp(REF_IN_TEXT.source, 'gi');
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const key = match[1].toUpperCase();
      if (projectKey && key === projectKey) {
        const a = document.createElement('a');
        a.className = 'blocked-ref mono';
        a.href = '/p/' + encodeURIComponent(slug) + '/i/' + encodeURIComponent(match[0].toUpperCase());
        a.textContent = match[0];
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(match[0]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // A compact relative time for a crowded row — "3m", "5h", "2d" — where `fmt`
  // gives the full timestamp for a title= attribute or a page with room to
  // spare. Past a month a short date reads better than a triple-digit day
  // count, and future timestamps (clock skew, an imported document) fall back
  // to `fmt` rather than printing a negative number.
  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return fmt(iso);
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + 'd';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- Due dates and priority ----
  //
  // `dueAt` is a calendar day (YYYY-MM-DD), so it is read as the viewer's own
  // local day, never through Date.parse — which treats a bare date as UTC
  // midnight and shows "due yesterday" to anybody west of Greenwich.

  // Only an open to-do is highlighted. Due dates exist on to-dos alone; a
  // deferred, finished or cancelled one that was due last week is not
  // overdue, and a list that shouts about done work stops being read.
  const DUE_BANDED_STATUSES = ['todo'];

  // The bands, nearest first. `max` is the last day-count (from today) a band
  // holds: overdue is anything before today, then today, tomorrow, the rest of
  // the coming week (2 to 6 days out), and everything later. The near three
  // are what a person acts on, so each gets its own look; "within 3 days" used
  // to put today and the day after next in one band, and a to-do due today
  // looked the same as one that could wait until Thursday. The week band is a
  // rolling seven days, not the calendar week, so it means the same thing on
  // a Friday as on a Monday.
  const DUE_BANDS = [
    { id: 'overdue', label: 'Overdue', max: -1 },
    { id: 'today', label: 'Due today', max: 0 },
    { id: 'tomorrow', label: 'Due tomorrow', max: 1 },
    { id: 'week', label: 'Due within a week', max: 6 },
    { id: 'later', label: 'Due later', max: Infinity },
  ];

  const PRIORITIES = ['p1', 'p2', 'p3'];
  // Stored and sent as p1/p2/p3; shown as words. A person reads "High" at a
  // glance, where "P1" has to be decoded (QA feedback on the first release).
  const PRIORITY_LABELS = { p1: 'High', p2: 'Medium', p3: 'Low' };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Today as the viewer's own calendar day. `now` is injectable for tests.
  function localToday(now) {
    const d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayNumber(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return null;
    // UTC arithmetic on both sides, so a daylight-saving change between today
    // and the due date cannot turn 7 days into 6.96.
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  }

  /** Whole days from `today` to `dueAt`: negative when past, 0 on the day. */
  function daysUntil(dueAt, today) {
    const due = dayNumber(dueAt);
    const now = dayNumber(today || localToday());
    if (due === null || now === null) return null;
    return Math.round(due - now);
  }

  /** The band id for a due date (see DUE_BANDS), or null when there is none. */
  function dueBand(dueAt, today) {
    const days = daysUntil(dueAt, today);
    if (days === null) return null;
    for (const band of DUE_BANDS) if (days <= band.max) return band.id;
    return 'later';
  }

  function dueDateLabel(dueAt, long) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueAt || '');
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const opts = long
      ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
    if (!long && d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  // The words on the chip carry the band as well as its colour, so the
  // highlight never depends on colour alone: "Overdue 2d", "Due today",
  // "Due in 5d", or the date itself once it is more than a month out.
  function dueText(dueAt, today) {
    const days = daysUntil(dueAt, today);
    if (days === null) return '';
    if (days < 0) return 'Overdue ' + -days + 'd';
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    if (days <= 30) return 'Due in ' + days + 'd';
    return 'Due ' + dueDateLabel(dueAt);
  }

  // The due chip for a row or a card, or null when the item has no due date.
  // A settled item (anything not live) shows its date plainly, unhighlighted.
  function dueChip(item, today) {
    if (!item || !item.dueAt) return null;
    const live = DUE_BANDED_STATUSES.indexOf(item.status) !== -1;
    const band = live ? dueBand(item.dueAt, today) : 'settled';
    const chip = document.createElement('span');
    chip.className = 'due mono b-' + band;
    chip.title = 'Due ' + dueDateLabel(item.dueAt, true) + ' (' + item.dueAt + ')';
    // Overdue carries a mark as well as its colour and fill, so the one that
    // is late reads as late in greyscale and to anybody who cannot tell red
    // from orange. The mark is decoration; the words still say "Overdue".
    if (band === 'overdue') {
      const mark = document.createElement('span');
      mark.className = 'due-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '!';
      chip.appendChild(mark);
    }
    chip.appendChild(document.createTextNode(live ? dueText(item.dueAt, today) : 'Due ' + dueDateLabel(item.dueAt)));
    return chip;
  }

  // The band a row is highlighted by, or null. Only an open to-do that is
  // overdue, due today or due tomorrow: those three are what a person acts on,
  // so the row's edge and tint carry them before the chip is read. A to-do due
  // later in the week, or later still, leaves the row alone and lets the chip
  // speak.
  const ROW_BANDS = ['overdue', 'today', 'tomorrow'];
  function dueRowBand(item, today) {
    if (!item || !item.dueAt || DUE_BANDED_STATUSES.indexOf(item.status) === -1) return null;
    const band = dueBand(item.dueAt, today);
    return ROW_BANDS.indexOf(band) === -1 ? null : band;
  }

  function priorityChip(priority) {
    if (!PRIORITY_LABELS[priority]) return null;
    const chip = document.createElement('span');
    chip.className = 'prio mono p-' + priority;
    chip.textContent = PRIORITY_LABELS[priority];
    chip.title = PRIORITY_LABELS[priority] + ' priority';
    return chip;
  }

  // Row order for sortBy `due` and `priority`. Each returns 0 on a tie so the
  // caller can fall through to its usual order (activity, newest first).
  function byDue(a, b) {
    const da = dayNumber(a.dueAt);
    const db = dayNumber(b.dueAt);
    if (da === db) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  // The page's "due" order, and the order `wb todos` prints: soonest due first,
  // undated last, then high priority before low on the same day (or no day).
  function byDueThenPriority(a, b) {
    const pa = PRIORITIES.indexOf(a.priority);
    const pb = PRIORITIES.indexOf(b.priority);
    return byDue(a, b) || (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  }
  function byPriority(a, b) {
    const pa = PRIORITIES.indexOf(a.priority);
    const pb = PRIORITIES.indexOf(b.priority);
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) || byDue(a, b);
  }

  // A date field and a priority select for one item, saving each on change.
  // Shared by the item page and an expanded row so the two cannot drift.
  // `save` receives the PATCH body ({dueAt} or {priority}); null clears.
  function planControls(item, save) {
    const wrap = document.createElement('span');
    wrap.className = 'planbar';

    const dl = document.createElement('label');
    dl.className = 'lbl';
    dl.setAttribute('for', 'due-' + item.id);
    dl.textContent = 'Due';
    const date = document.createElement('input');
    date.type = 'date';
    date.id = 'due-' + item.id;
    date.className = 'plan-date';
    date.value = item.dueAt || '';
    // Committed when the field is left (or on Enter), and only if the value
    // moved. Saving on every `change` wrote each valid date a browser passes
    // through while a year is typed (0002, 0020, 0202, 2026).
    let committed = item.dueAt || '';
    const commit = () => {
      const value = date.value || '';
      if (value === committed) return;
      committed = value;
      save({ dueAt: value || null });
    };
    date.addEventListener('blur', commit);
    date.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    const pl = document.createElement('label');
    pl.className = 'lbl';
    pl.setAttribute('for', 'prio-' + item.id);
    pl.textContent = 'Priority';
    const sel = document.createElement('select');
    sel.id = 'prio-' + item.id;
    sel.className = 'plan-prio';
    for (const value of [''].concat(PRIORITIES)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value ? PRIORITY_LABELS[value] : 'None';
      if ((item.priority || '') === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => save({ priority: sel.value || null }));

    wrap.append(dl, date, pl, sel);
    return wrap;
  }

  // Images (contract v22). A picture goes in as Markdown text, the same way a
  // person or an agent writes one: the file is uploaded first, and the reply
  // box receives `![name](/api/images/<hash>.png)` at the cursor, where it can
  // be moved, captioned or deleted before sending. Nothing is posted until
  // Send, so attaching is never itself a message.
  //
  // `textareaId` is looked up again when the upload finishes, because the page
  // repaints every few seconds and the box the file was dropped on may have
  // been replaced by an identical one meanwhile.
  async function uploadImage(file) {
    const res = await fetch('/api/images?alt=' + '', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || 'upload failed (' + res.status + ')');
    return data.image;
  }

  function insertAtCursor(ta, text) {
    const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const end = ta.selectionEnd != null ? ta.selectionEnd : start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    // Each image on its own line, so it renders as a block, not mid-sentence.
    const lead = before && !/\n$/.test(before) ? '\n' : '';
    const tail = after && !/^\n/.test(after) ? '\n' : '';
    ta.value = before + lead + text + tail + after;
    const at = (before + lead + text).length;
    try { ta.setSelectionRange(at, at); } catch (e) { /* not focusable yet */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function attachFiles(textareaId, files, note) {
    const images = Array.prototype.filter.call(files || [], (f) => /^image\//.test(f.type));
    if (!images.length) { if (files && files.length) note('only images can be attached', true); return; }
    for (const file of images) {
      note('uploading ' + (file.name || 'image') + '…');
      try {
        const image = await uploadImage(file);
        const ta = document.getElementById(textareaId);
        if (ta) insertAtCursor(ta, image.markdown);
        note('image attached — it is sent with the reply');
      } catch (e) {
        note(e.message, true);
        return;
      }
    }
  }

  // Wires paste and drop on a reply box and returns the Image button for it.
  function imageAttach(ta, note) {
    ta.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && Array.prototype.some.call(files, (f) => /^image\//.test(f.type))) {
        e.preventDefault();
        attachFiles(ta.id, files, note);
      }
    });
    ta.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) {
        e.preventDefault();
        ta.classList.add('dropping');
      }
    });
    ta.addEventListener('dragleave', () => ta.classList.remove('dropping'));
    ta.addEventListener('drop', (e) => {
      ta.classList.remove('dropping');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        attachFiles(ta.id, e.dataTransfer.files, note);
      }
    });
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', () => { attachFiles(ta.id, input.files, note); input.value = ''; });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attach';
    btn.textContent = 'Image';
    btn.title = 'Attach an image (or paste or drop one into the box)';
    btn.setAttribute('aria-label', 'Attach an image');
    btn.addEventListener('click', () => input.click());
    const wrap = document.createElement('span');
    wrap.className = 'attachwrap';
    wrap.append(btn, input);
    return wrap;
  }

  // Click to enlarge. md.js renders every image as a link to the file, so with
  // script off (or a modifier key held) it opens full size in a new tab; a
  // plain click shows it over the page instead. Escape, a click or the close
  // button dismisses it.
  let lightbox = null;
  function openLightbox(src, alt) {
    if (!lightbox) {
      const box = document.createElement('div');
      box.id = 'wb-lightbox';
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.tabIndex = -1;
      const img = document.createElement('img');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'lightbox-close';
      close.textContent = 'Close';
      const open = document.createElement('a');
      open.className = 'lightbox-open';
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open full size';
      const bar = document.createElement('div');
      bar.className = 'lightbox-bar';
      bar.append(open, close);
      box.append(img, bar);
      box.addEventListener('click', (e) => { if (e.target !== open) closeLightbox(); });
      document.body.appendChild(box);
      lightbox = { box, img, open };
    }
    lightbox.img.src = src;
    lightbox.img.alt = alt || '';
    lightbox.box.setAttribute('aria-label', alt ? 'Image: ' + alt : 'Image');
    lightbox.open.href = src;
    lightbox.box.hidden = false;
    lightbox.box.focus();
  }
  function closeLightbox() {
    if (lightbox) lightbox.box.hidden = true;
  }
  // Guarded because the helpers in this file are also loaded on their own,
  // without a page, by tests of the date and priority logic.
  if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a.md-imglink') : null;
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const img = link.querySelector('img');
    openLightbox(link.getAttribute('href'), img ? img.alt : '');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
  }

  // ---- Question sets (contract v23) ----
  //
  // One panel, drawn the same on the item page and inside an expanded card on
  // the project page. "Answered" is the one definition the server uses (a
  // choice, or a non-blank note) so the count here and the count on the row
  // cannot disagree.
  function isAnswered(q) {
    return !!(q && (q.choice || String(q.answer || '').trim()));
  }

  // Kept across repaints, because the page redraws on every poll: what was
  // typed and not yet saved, and which answered questions are open for change.
  const qDrafts = {};
  const qOpen = {};

  function qEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // The chip beside a question set's status: how many questions it holds,
  // green once every one is answered. Words first, colour second.
  function questionsChip(item) {
    if (!item || item.kind !== 'questions') return null;
    const total = item.questionCount || 0;
    const chip = qEl('span', 'qa-chip qs-chip' + (total && item.answered === total ? ' done' : ''), total + (total === 1 ? ' question' : ' questions'));
    return chip;
  }

  // `hooks`: onItem(item) after a successful write, note(text, isErr) for the
  // page's own message area. Every write is one PATCH for one question.
  function questionsPanel(item, hooks) {
    const root = qEl('section', 'qset');
    root.setAttribute('aria-label', 'Questions');
    const qs = item.questions || [];
    const done = qs.filter(isAnswered).length;
    const path = (qid) => '/api/items/' + encodeURIComponent(item.id) + '/questions/' + encodeURIComponent(qid);
    const say = (text, isErr) => { if (hooks && hooks.note) hooks.note(text, isErr); };

    async function save(qid, body) {
      say('saving…');
      try {
        const res = await window.WB.patch(path(qid), Object.assign({ actor: 'you' }, body));
        delete qDrafts[item.id + '/' + qid];
        delete qOpen[item.id + '/' + qid];
        if (hooks && hooks.onItem) hooks.onItem(res.item);
        say(res.warning ? res.warning : 'saved', Boolean(res.warning));
      } catch (e) { say(e.message, true); }
    }

    // The sticky header, like the checks one: the label, the count, the bar,
    // and the one-click way through the questions the agent already has a
    // single recommendation for.
    const head = qEl('div', 'checkhead sticky qhead');
    head.appendChild(qEl('span', 'mono', 'Questions'));
    head.appendChild(qEl('span', 'mono qcount', done + ' of ' + qs.length + ' answered'));
    const bar = qEl('div', 'progress');
    const fill = qEl('div', 'fill');
    fill.style.width = (qs.length ? (done / qs.length) * 100 : 0) + '%';
    bar.appendChild(fill);
    head.appendChild(bar);
    const acceptable = qs.filter((q) => !isAnswered(q) && (q.recommended || []).length === 1);
    if (acceptable.length) {
      const all = qEl('button', 'send qaccept', 'Accept all recommendations');
      all.type = 'button';
      all.title = 'Answer ' + acceptable.length + ' open question' + (acceptable.length === 1 ? '' : 's') + ' with the option the agent recommends';
      all.addEventListener('click', async () => {
        say('saving…');
        let latest = null;
        for (const q of acceptable) {
          // Somebody may have answered it since this page drew; that answer stands.
          const now = latest && (latest.questions || []).find((x) => x.id === q.id);
          if (now && isAnswered(now)) continue;
          try {
            const res = await window.WB.patch(path(q.id), { choice: q.recommended[0], actor: 'you' });
            latest = res.item;
            delete qDrafts[item.id + '/' + q.id];
          } catch (e) { say(q.id + ': ' + e.message, true); break; }
        }
        if (latest && hooks && hooks.onItem) hooks.onItem(latest);
        if (latest) say('saved');
      });
      head.appendChild(all);
    }
    root.appendChild(head);

    for (const q of qs) {
      const key = item.id + '/' + q.id;
      const answered = isAnswered(q);
      const open = !answered || qOpen[key];
      const block = qEl('div', 'qrow ' + (answered ? 'q-done' : 'q-open') + (answered && open ? ' q-editing' : ''));
      block.id = 'q-' + item.id + '-' + q.id;

      if (!open) {
        block.appendChild(qEl('span', 'q-tick', '\u2713'));
        block.appendChild(qEl('span', 'mono qid', q.id));
        block.appendChild(qEl('strong', 'qlabel', q.label || q.id));
        const text = [q.choice, String(q.answer || '').trim()].filter(Boolean).join(' \u2014 ');
        const a = qEl('span', 'qanswer-text');
        a.innerHTML = window.MD.inline(text);
        block.appendChild(a);
        const meta = qEl('span', 'mono qmeta', (q.by || 'you') + (q.at ? ' \u00b7 ' + relTime(q.at) : ''));
        if (q.at) meta.title = fmt(q.at);
        block.appendChild(meta);
        if (q.relayed) block.appendChild(qEl('span', 'mono q-relayed', 'relayed'));
        const change = qEl('button', 'labeledit mono qchange', 'change');
        change.type = 'button';
        change.setAttribute('aria-label', 'Change the answer to ' + (q.label || q.id));
        change.addEventListener('click', () => { qOpen[key] = true; if (hooks && hooks.repaint) hooks.repaint(); });
        block.appendChild(change);
        root.appendChild(block);
        continue;
      }

      const top = qEl('div', 'qtop');
      top.appendChild(qEl('span', 'mono qid', q.id));
      top.appendChild(qEl('strong', 'qlabel', q.label || q.id));
      block.appendChild(top);
      if (q.ask) {
        const ask = qEl('div', 'md qask');
        ask.innerHTML = window.MD(q.ask, { breaks: true });
        block.appendChild(ask);
      }

      const input = qEl('input', 'q-input');
      input.type = 'text';
      input.setAttribute('aria-label', 'Answer for ' + (q.label || q.id));
      input.placeholder = (q.options || []).length ? 'Add a note (optional)' : 'Your answer';
      input.value = key in qDrafts ? qDrafts[key] : (q.answer || '');
      input.addEventListener('input', () => { qDrafts[key] = input.value; });

      if ((q.options || []).length) {
        const opts = qEl('div', 'opts');
        opts.setAttribute('role', 'group');
        opts.setAttribute('aria-label', q.label || q.id);
        for (const o of q.options) {
          const b = document.createElement('button');
          b.type = 'button';
          b.innerHTML = window.MD.inline(o);
          if ((q.recommended || []).indexOf(o) !== -1) {
            b.classList.add('rec');
            b.append(' ', qEl('span', 'rec-tag', 'Recommended'));
          }
          b.setAttribute('aria-pressed', q.choice === o ? 'true' : 'false');
          // A click is the answer; a note already typed rides along with it.
          b.addEventListener('click', () => {
            const body = { choice: o };
            const note = input.value.trim();
            if (note) body.answer = note;
            save(q.id, body);
          });
          opts.appendChild(b);
        }
        block.appendChild(opts);
      }

      const form = qEl('div', 'qform');
      const saveBtn = qEl('button', 'send qsave', 'Save');
      saveBtn.type = 'button';
      saveBtn.setAttribute('aria-label', 'Save answer for ' + (q.label || q.id));
      const submit = () => {
        const body = {};
        if (q.choice) body.choice = q.choice;
        if (input.value.trim()) body.answer = input.value.trim();
        save(q.id, body);
      };
      saveBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      form.append(input, saveBtn);
      if (answered) {
        const clear = qEl('button', 'labeledit mono qclear', 'Clear');
        clear.type = 'button';
        clear.setAttribute('aria-label', 'Clear the answer to ' + (q.label || q.id));
        clear.addEventListener('click', () => save(q.id, { clear: true }));
        form.appendChild(clear);
      }
      block.appendChild(form);
      root.appendChild(block);
    }
    return root;
  }

  return {
    isWork,
    isAnswered,
    questionsPanel,
    questionsChip,
    DUE_BANDED_STATUSES,
    imageAttach,
    uploadImage,
    openLightbox,
    TODO_STATUSES,
    DUE_BANDS,
    PRIORITIES,
    PRIORITY_LABELS,
    localToday,
    daysUntil,
    dueBand,
    dueText,
    dueChip,
    dueRowBand,
    priorityChip,
    byDue,
    byDueThenPriority,
    byPriority,
    planControls,
    serialPatch,
    STATUS_LABELS,
    WAITING_ON_YOU,
    QA_LABELS,
    qaChip,
    waitingOnYou,
    DOCUMENT_STATUSES,
    ISSUE_STATUSES,
    statusesFor,
    labelChoices,
    refChip,
    renderBlockedBy,
    STATUSES: Object.keys(STATUS_LABELS),
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    fmt,
    relTime,
  };
})();

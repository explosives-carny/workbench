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
  const ISSUE_STATUSES = Object.keys(STATUS_LABELS).filter((s) => DOCUMENT_STATUSES.indexOf(s) === -1);

  // The statuses an item may hold, by what it IS. The two sets do not overlap:
  // offering all seven let a specification be set to "Received", which is the
  // exact confusion the split exists to prevent.
  function statusesFor(kind) {
    return kind === 'document' ? DOCUMENT_STATUSES : ISSUE_STATUSES;
  }

  // Statuses that mean the human owes something. The index card counts these
  // together, because "how much is on me" is one number to a person even though
  // the two asks are different in kind.
  const WAITING_ON_YOU = ['needs-decision', 'needs-qa'];

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

  return {
    STATUS_LABELS,
    WAITING_ON_YOU,
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

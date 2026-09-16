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
    'deferred': 'Deferred',
    active: 'Active',
    archived: 'Archived',
    complete: 'Complete',
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

  return {
    STATUS_LABELS,
    WAITING_ON_YOU,
    DOCUMENT_STATUSES,
    ISSUE_STATUSES,
    statusesFor,
    STATUSES: Object.keys(STATUS_LABELS),
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    fmt,
  };
})();

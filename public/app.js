// Shared client helpers. Deliberately no framework: the whole point of this
// tool is that it costs nothing to run and nothing to rebuild.
window.WB = (function () {
  const STATUS_LABELS = {
    'needs-you': 'Needs you',
    received: 'Received',
    'needs-more': 'Needs more',
    complete: 'Complete',
  };

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

  function fmt(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  return {
    STATUS_LABELS,
    STATUSES: Object.keys(STATUS_LABELS),
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    fmt,
  };
})();

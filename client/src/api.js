export const STATUSES = ['Not Applied', 'To Apply', 'Applied', 'Replied', 'Interview', 'Rejected', 'Offer'];
export const FUNDING_STATUSES = ['unknown', 'bootstrapped', 'funded'];
export const FUNDING_STAGES = ['unknown', 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c+', 'other'];

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Cannot reach the API. Is the server running on port 4000?');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== '' && v != null && p.set(k, v));
  return p.toString();
};

export const api = {
  list: (filters) => req(`/companies?${qs(filters)}`),
  facets: () => req('/facets'),
  stats: () => req('/stats'),
  update: (id, patch) => req(`/companies/${id}`, json('PATCH', patch)),
  create: (body) => req('/companies', json('POST', body)),
  remove: (id) => req(`/companies/${id}`, { method: 'DELETE' }),
  company: (id) => req(`/companies/${id}`),
  applications: (companyId) => req(`/companies/${companyId}/applications`),
  addApplication: (companyId, body) => req(`/companies/${companyId}/applications`, json('POST', body)),
  updateApplication: (id, body) => req(`/applications/${id}`, json('PATCH', body)),
  removeApplication: (id) => req(`/applications/${id}`, { method: 'DELETE' }),
  addActivity: (id, note) => req(`/applications/${id}/activity`, json('POST', { note })),
  followUps: (limit = 5) => req(`/applications?followUpDue=true&limit=${limit}`),
  exportApplicationsUrl: '/api/applications/export',
  research: (id) => req(`/companies/${id}/research`, { method: 'POST' }),
  researchBatch: (ids) => req('/research/batch', json('POST', { ids })),
  researchConfig: () => req('/research/config'),
  decideFinding: (id, fid, body) => req(`/companies/${id}/findings/${fid}`, json('POST', body)),
  decideFindings: (id, body) => req(`/companies/${id}/findings`, json('POST', body)),
  importPreview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return req('/import/preview', { method: 'POST', body: fd });
  },
  importRun: (file, { mapping, policy, decisions, dryRun }) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mapping', JSON.stringify(mapping));
    fd.append('policy', policy);
    fd.append('decisions', JSON.stringify(decisions));
    fd.append('dryRun', String(dryRun));
    return req('/import', { method: 'POST', body: fd });
  },
  exportUrl: (filters) => `/api/export?${qs(filters)}`,
};

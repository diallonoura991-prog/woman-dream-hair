const $ = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => new Intl.NumberFormat('fr-FR').format(Number(value || 0)) + ' FCFA';
let dashboard = null, catalog = { services: [], payments: [] }, archiveTimer, archiveRequest = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || 'Une erreur est survenue.');
  return data;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function showPage(id) {
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === id));
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === id));
  $('crumb').textContent = { accueil: 'Accueil', saisie: 'Saisie du jour', archives: 'Archives', catalogue: 'Prestations & paiements' }[id] || 'Accueil';
  if (id === 'archives') loadArchive();
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.jump)));

function renderSelects() {
  $('service').innerHTML = '<option value="">Choisir une prestation</option>'
    + catalog.services.map(s => `<option value="${html(s.name)}">${html(s.name)}</option>`).join('')
    + '<option value="__add">＋ Ajouter une prestation…</option>';
  $('payment').innerHTML = '<option value="">Choisir un mode de paiement</option>'
    + catalog.payments.map(p => `<option value="${html(p.name)}">${html(p.name)}</option>`).join('')
    + '<option value="__add">＋ Ajouter un mode de paiement…</option>';
  $('serviceList').innerHTML = catalog.services.map(s =>
    `<div class="catalog-row"><span>${html(s.name)}</span><button class="remove" data-remove-service="${html(s.id)}">Retirer</button></div>`
  ).join('') || '<div class="empty">Aucune prestation dans la liste.</div>';
  $('paymentList').innerHTML = catalog.payments.map(p =>
    `<div class="catalog-row"><span>${html(p.name)}</span><span class="pill">Actif</span></div>`
  ).join('');
}
function row(e, withDate = false) {
  const date = withDate ? `${html(e.entryDate)} · ` : '';
  return `<tr><td>${date}${html(e.entryTime)}</td><td>${html(e.client)}</td><td>${html(e.service)}</td><td><span class="pill">${html(e.paymentMethod)}</span></td><td class="amount">${money(e.amount)}</td></tr>`;
}
function setTodayLabel(date) {
  const d = new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
function renderDashboard() {
  if (!dashboard) return;
  const today = dashboard.today || [];
  const date = dashboard.date;
  const day = new Date(`${date}T12:00:00`);
  $('dateChip').textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(day);
  $('todayLabel').textContent = setTodayLabel(date);
  $('entryDate').textContent = 'Aujourd’hui · ' + setTodayLabel(date);
  $('dayTotal').textContent = money(dashboard.total);
  $('dayCount').textContent = `${dashboard.count} prestation${dashboard.count === 1 ? '' : 's'} enregistrée${dashboard.count === 1 ? '' : 's'}`;
  $('countValue').textContent = dashboard.count;
  $('averageValue').textContent = money(dashboard.count ? Math.round(dashboard.total / dashboard.count) : 0);
  $('todayRows').innerHTML = today.slice(0, 7).map(e =>
    `<tr><td><div class="client"><span class="client-mark">${html((e.client || '?').trim().charAt(0).toUpperCase())}</span><b>${html(e.client)}</b></div></td><td>${html(e.service)}</td><td><span class="pill">${html(e.paymentMethod)}</span></td><td class="amount">${money(e.amount)}</td></tr>`
  ).join('');
  $('todayEmpty').classList.toggle('hidden', today.length > 0);
  $('dailyRows').innerHTML = today.map(e => row(e)).join('');
  $('dailyEmpty').classList.toggle('hidden', today.length > 0);
  $('dailyCaption').textContent = `${today.length} prestation${today.length === 1 ? '' : 's'} enregistrée${today.length === 1 ? '' : 's'} aujourd’hui`;
  $('dailyTotal').textContent = 'Total : ' + money(dashboard.total);
  $('paymentSummary').innerHTML = (dashboard.summary || []).map(p =>
    `<div class="payment-line"><b>${html(p.name)}</b><span>${money(p.total)}</span></div>`
  ).join('');
  const days = dashboard.week || [];
  const max = Math.max(1, ...days.map(d => Number(d.total)));
  $('weekTotal').textContent = money(days.reduce((sum, d) => sum + Number(d.total), 0));
  $('chart').innerHTML = days.map(d =>
    `<div class="bar-col"><div class="bar ${d.date === date ? 'today' : ''}" style="height:${Math.max(5, Number(d.total) / max * 100)}%" title="${money(d.total)}"></div></div>`
  ).join('');
}
function renderArchiveRows(data) {
  $('archiveRows').innerHTML = data.entries.map(e => row(e, true)).join('');
  $('archiveEmpty').classList.toggle('hidden', data.entries.length > 0);
  $('archiveSummary').textContent = `${data.total} prestation${data.total === 1 ? '' : 's'} · total affiché ${money(data.entries.reduce((sum, e) => sum + e.amount, 0))}`;
}
function archiveQuery() {
  const params = new URLSearchParams();
  if ($('yearFilter').value) params.set('year', $('yearFilter').value);
  if ($('monthFilter').value) params.set('month', $('monthFilter').value);
  if ($('clientFilter').value.trim()) params.set('client', $('clientFilter').value.trim());
  return params.toString();
}
async function loadArchive() {
  const requestId = ++archiveRequest;
  $('archiveSummary').textContent = 'Recherche des archives…';
  try {
    const result = await api('/api/archive?' + archiveQuery());
    if (requestId === archiveRequest) renderArchiveRows(result);
  } catch (error) {
    if (requestId === archiveRequest) $('archiveSummary').textContent = error.message;
  }
}
async function loadDashboard() {
  dashboard = await api('/api/bootstrap');
  catalog.services = dashboard.services || [];
  catalog.payments = dashboard.payments || [];
  renderSelects();
  renderDashboard();
}
async function startApp() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) {
      $('appShell').classList.add('hidden');
      $('loginScreen').classList.remove('hidden');
      return;
    }
    $('loginScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    await loadDashboard();
  } catch (error) {
    $('appShell').classList.add('hidden');
    $('loginScreen').classList.remove('hidden');
    $('loginError').textContent = error.message;
  }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await startApp();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});
$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  $('appShell').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
});

$('service').addEventListener('change', event => {
  const add = event.target.value === '__add';
  $('addServiceRow').classList.toggle('hidden', !add);
  if (add) { event.target.value = ''; $('newService').focus(); }
});
$('payment').addEventListener('change', event => {
  const add = event.target.value === '__add';
  $('addPaymentRow').classList.toggle('hidden', !add);
  if (add) { event.target.value = ''; $('newPayment').focus(); }
});
async function createService(name, selectAfter = false) {
  name = name.trim();
  if (!name) return;
  await api('/api/services', { method: 'POST', body: JSON.stringify({ name }) });
  await loadDashboard();
  if (selectAfter) $('service').value = name;
}
async function createPayment(name, selectAfter = false) {
  name = name.trim();
  if (!name) return;
  await api('/api/payment-modes', { method: 'POST', body: JSON.stringify({ name }) });
  await loadDashboard();
  if (selectAfter) $('payment').value = name;
}
$('saveService').addEventListener('click', async () => {
  try { await createService($('newService').value, true); $('newService').value = ''; $('addServiceRow').classList.add('hidden'); toast('Prestation ajoutée.'); }
  catch (error) { toast(error.message); }
});
$('savePayment').addEventListener('click', async () => {
  try { await createPayment($('newPayment').value, true); $('newPayment').value = ''; $('addPaymentRow').classList.add('hidden'); toast('Mode de paiement ajouté.'); }
  catch (error) { toast(error.message); }
});
$('addServiceCatalog').addEventListener('click', async () => {
  try { await createService($('newServiceCatalog').value); $('newServiceCatalog').value = ''; toast('Prestation ajoutée à la liste.'); }
  catch (error) { toast(error.message); }
});
$('addPaymentCatalog').addEventListener('click', async () => {
  try { await createPayment($('newPaymentCatalog').value); $('newPaymentCatalog').value = ''; toast('Mode de paiement ajouté.'); }
  catch (error) { toast(error.message); }
});
$('serviceList').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-service]');
  if (!button) return;
  if (!confirm('Retirer cette prestation de la liste ? Les archives ne seront pas modifiées.')) return;
  try {
    await api('/api/services/' + encodeURIComponent(button.dataset.removeService), { method: 'DELETE' });
    await loadDashboard();
    toast('Prestation retirée de la liste.');
  } catch (error) { toast(error.message); }
});
$('entryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/entries', { method: 'POST', body: JSON.stringify({
      client: $('client').value.trim(), service: $('service').value,
      payment: $('payment').value, amount: Number($('amount').value)
    }) });
    event.target.reset();
    $('addServiceRow').classList.add('hidden');
    $('addPaymentRow').classList.add('hidden');
    await loadDashboard();
    toast('Prestation enregistrée dans les archives.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
['yearFilter', 'monthFilter'].forEach(id => $(id).addEventListener('change', loadArchive));
$('clientFilter').addEventListener('input', () => { clearTimeout(archiveTimer); archiveTimer = setTimeout(loadArchive, 250); });
$('exportBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/archive-export?' + archiveQuery(), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Impossible de préparer l’export.');
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'archives-woman-dream-hair.csv'; a.click(); URL.revokeObjectURL(url);
  } catch (error) { toast(error.message); }
});
startApp();

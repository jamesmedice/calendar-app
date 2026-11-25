const $ = (id) => document.getElementById(id);
let calendar;
let csrfToken = '';
let toastTimer;
let bookingRecords = new Map();
let clients = [];
let selectedClientEmail = '';
let reportPayments = [];
const dialog = $('event-dialog');

function showView(viewName) {
  const views = {
    welcome: 'welcome-view',
    calendar: 'calendar-view',
    payments: 'payments-view',
    clients: 'clients-view',
    reports: 'reports-view'
  };
  Object.entries(views).forEach(([name, id]) => {
    $(id).hidden = name !== viewName;
  });
  document.querySelectorAll('.menu-item').forEach((item) => {
    const active = item.dataset.view === viewName;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  closeMenu();
  if (viewName === 'calendar' && calendar) calendar.updateSize();
  if (viewName === 'payments') loadPaymentsPage();
  if (viewName === 'clients') loadClientsPage();
  if (viewName === 'reports') loadReportsPage();
}

function closeMenu() {
  document.body.classList.remove('menu-open');
  $('menu-toggle').setAttribute('aria-expanded', 'false');
  $('menu-toggle').setAttribute('aria-label', 'Apri il menu di navigazione');
  $('side-menu').setAttribute('aria-hidden', 'true');
  $('menu-scrim').hidden = true;
}

function toggleMenu() {
  const isOpen = document.body.classList.toggle('menu-open');
  $('menu-toggle').setAttribute('aria-expanded', String(isOpen));
  $('menu-toggle').setAttribute('aria-label', isOpen ? 'Chiudi il menu di navigazione' : 'Apri il menu di navigazione');
  $('side-menu').setAttribute('aria-hidden', String(!isOpen));
  $('menu-scrim').hidden = !isOpen;
}

function toast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Richiesta non riuscita (${response.status})`);
  return data;
}
function toLocalInput(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00`;
  }
  const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function formatDateTime(value) {
  if (!value) return 'Data non disponibile';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value);
  if (!Number.isFinite(date.getTime())) return 'Data non disponibile';
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'medium',
    timeStyle: /^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : 'short'
  }).format(date);
}
function formatAmount(value) {
  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value));
}
function renderPayments(payments) {
  $('payment-count').textContent = String(payments.length);
  $('payment-empty').hidden = payments.length > 0;
  $('payment-list').innerHTML = payments.map((payment) => {
    const statusClass = {
      'In Attesa': 'pending',
      'Pagato': 'paid',
      'Annullato': 'cancelled'
    }[payment.status] || 'pending';
    const bookingName = payment.eventTitle || (payment.eventId ? 'Appuntamento collegato' : 'Inserimento manuale');
    return `<tr>
      <td><strong>${escapeHtml(payment.clientEmail)}</strong><small>Inserito il ${escapeHtml(formatDateTime(payment.createdAt))}</small></td>
      <td><strong>${escapeHtml(bookingName)}</strong><small>${escapeHtml(formatDateTime(payment.examDate))}</small></td>
      <td class="amount-cell">${escapeHtml(formatAmount(payment.amount))}</td>
      <td><span class="status-badge ${statusClass}">${escapeHtml(payment.status)}</span></td>
    </tr>`;
  }).join('');
}
async function loadPaymentsPage() {
  $('payment-list').innerHTML = '';
  $('payment-empty').hidden = false;
  $('payment-empty').textContent = 'Caricamento dei pagamenti…';
  if (!$('payment-exam-date').value) {
    $('payment-exam-date').value = toLocalInput(new Date());
  }

  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const end = new Date();
  end.setFullYear(end.getFullYear() + 2);
  const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  const [paymentResult, bookingResult] = await Promise.allSettled([
    api('/api/payments'),
    api(`/api/events?${query}`)
  ]);

  if (paymentResult.status === 'fulfilled') {
    renderPayments(paymentResult.value);
  } else {
    $('payment-empty').textContent = 'Impossibile caricare i pagamenti.';
    toast(paymentResult.reason.message);
  }

  if (bookingResult.status === 'fulfilled') {
    bookingRecords = new Map(bookingResult.value.map((event) => [event.id, event]));
    const bookingSelect = $('payment-booking');
    bookingSelect.innerHTML = '<option value="">Nessun appuntamento — inserisci data e ora</option>';
    bookingResult.value.forEach((event) => {
      const option = document.createElement('option');
      option.value = event.id;
      option.textContent = `${event.title} · ${formatDateTime(event.start)}`;
      bookingSelect.appendChild(option);
    });
  } else {
    bookingRecords = new Map();
    toast(`Impossibile caricare gli appuntamenti: ${bookingResult.reason.message}`);
  }
}
function clientInitials(profile) {
  const label = profile.name || profile.email || '?';
  return label.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}
function renderClientList() {
  const query = $('client-search').value.trim().toLowerCase();
  const filtered = clients.filter(client =>
    `${client.name || ''} ${client.email}`.toLowerCase().includes(query)
  );
  $('client-count').textContent = String(clients.length);
  $('client-list').innerHTML = filtered.map(client => `
    <button class="client-card${client.email.toLowerCase() === selectedClientEmail.toLowerCase() ? ' selected' : ''}"
      type="button" data-client-email="${escapeHtml(client.email)}">
      <span class="client-avatar">${escapeHtml(clientInitials(client))}</span>
      <span class="client-card-copy"><strong>${escapeHtml(client.name || client.email)}</strong>
        <small>${escapeHtml(client.email)}</small></span>
      <span class="client-card-count">${client.paymentCount || 0}</span>
    </button>
  `).join('');
  $('client-list-empty').hidden = filtered.length > 0;
  $('client-list-empty').textContent = clients.length
    ? 'Nessun cliente corrisponde alla ricerca.'
    : 'Aggiungi una scheda cliente o registra un pagamento per iniziare.';
}
function renderClientProfile(data, isNew = false) {
  const profile = data?.profile || { email: '', name: '', phone: '', notes: '', paymentCount: 0, bookingCount: 0 };
  const bookings = data?.bookings || [];
  const payments = data?.payments || [];
  $('client-profile-placeholder').hidden = true;
  $('client-profile-detail').innerHTML = `
    <div class="profile-header">
      <span class="profile-avatar">${escapeHtml(clientInitials(profile))}</span>
      <div class="profile-heading-copy">
        <p class="eyebrow">${isNew ? 'NUOVO CLIENTE' : 'SCHEDA CLIENTE'}</p>
        <h2>${escapeHtml(profile.name || (isNew ? 'Crea una scheda' : profile.email))}</h2>
        <p>${escapeHtml(profile.email || 'Inserisci un indirizzo email per creare la scheda.')}</p>
      </div>
      <div class="profile-stats">
        <span class="profile-stat"><strong>${profile.bookingCount || 0}</strong><small>APPUNTAMENTI</small></span>
        <span class="profile-stat"><strong>${profile.paymentCount || 0}</strong><small>PAGAMENTI</small></span>
      </div>
    </div>
    <form id="client-profile-form" class="profile-form">
      <label>Email
        <input id="client-profile-email" type="email" required maxlength="254" value="${escapeHtml(profile.email)}"
          placeholder="nome@esempio.it"${isNew ? '' : ' readonly'}>
      </label>
      <label>Nome
        <input id="client-profile-name" maxlength="120" value="${escapeHtml(profile.name)}" placeholder="Nome del cliente">
      </label>
      <label>Telefono
        <input id="client-profile-phone" type="tel" maxlength="40" value="${escapeHtml(profile.phone)}" placeholder="Facoltativo">
      </label>
      <label>Note
        <textarea id="client-profile-notes" maxlength="2000" rows="3" placeholder="Informazioni utili sul cliente">${escapeHtml(profile.notes)}</textarea>
      </label>
      <div class="profile-form-actions">
        <span id="client-profile-feedback" class="profile-form-message" role="status"></span>
        <button type="submit" class="button">${isNew ? 'Crea scheda' : 'Salva modifiche'}</button>
      </div>
    </form>
    <section class="profile-history">
      <h3>Appuntamenti <span class="history-count">${bookings.length}</span></h3>
      ${bookings.length ? `<div class="booking-list">${bookings.map(booking => `
        <div class="booking-row">
          <span class="booking-row-icon" aria-hidden="true">▦</span>
          <span class="booking-row-copy"><strong>${escapeHtml(booking.title)}</strong>
            <small>${escapeHtml(formatDateTime(booking.start))}</small></span>
          <span class="booking-pay-count">${booking.paymentCount} ${booking.paymentCount === 1 ? 'pagamento' : 'pagamenti'}</span>
        </div>`).join('')}</div>` : '<p class="history-empty">Non ci sono ancora appuntamenti collegati a questo cliente.</p>'}
    </section>
    <section class="profile-history">
      <h3>Pagamenti <span class="history-count">${payments.length}</span></h3>
      ${payments.length ? `<div class="payment-table-wrap"><table class="profile-payments">
        <thead><tr><th>DATA / APPUNTAMENTO</th><th>IMPORTO</th><th>STATO</th></tr></thead>
        <tbody>${payments.map(payment => {
          const statusClass = { 'In Attesa': 'pending', 'Pagato': 'paid', 'Annullato': 'cancelled' }[payment.status] || 'pending';
          return `<tr>
            <td><strong>${escapeHtml(payment.eventTitle || (payment.eventId ? 'Appuntamento collegato' : 'Inserimento manuale'))}</strong>
              <small>${escapeHtml(formatDateTime(payment.examDate))}</small></td>
            <td class="amount-cell">${escapeHtml(formatAmount(payment.amount))}</td>
            <td><span class="status-badge ${statusClass}">${escapeHtml(payment.status)}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p class="history-empty">Nessun pagamento registrato per questo cliente.</p>'}
    </section>
  `;
}
async function selectClient(email) {
  selectedClientEmail = email.toLowerCase();
  renderClientList();
  $('client-profile-placeholder').hidden = true;
  $('client-profile-detail').innerHTML = '<p class="history-empty">Caricamento della scheda cliente…</p>';
  try {
    const data = await api(`/api/clients/${encodeURIComponent(email)}`);
    renderClientProfile(data);
  } catch (error) {
    $('client-profile-detail').innerHTML = '';
    $('client-profile-placeholder').hidden = false;
    toast(error.message);
  }
}
async function loadClientsPage(emailToSelect = '') {
  try {
    clients = await api('/api/clients');
    renderClientList();
    const targetEmail = emailToSelect || selectedClientEmail;
    const target = clients.find(client => client.email.toLowerCase() === targetEmail.toLowerCase()) || clients[0];
    if (target) {
      await selectClient(target.email);
    } else {
      selectedClientEmail = '';
      $('client-profile-detail').innerHTML = '';
      $('client-profile-placeholder').hidden = false;
    }
  } catch (error) {
    toast(error.message);
    $('client-list-empty').textContent = 'Impossibile caricare le schede clienti.';
    $('client-list-empty').hidden = false;
  }
}
function renderReports() {
  const start = $('report-from').value;
  const end = $('report-to').value;
  const clientEmail = $('report-client').value.toLowerCase();
  const status = $('report-status').value;
  const filtered = reportPayments.filter(payment => {
    const bookingDay = String(payment.examDate || '').slice(0, 10);
    return (!start || bookingDay >= start) &&
      (!end || bookingDay <= end) &&
      (!clientEmail || String(payment.clientEmail).toLowerCase() === clientEmail) &&
      (!status || payment.status === status);
  }).sort((a, b) => String(b.examDate).localeCompare(String(a.examDate)));

  const total = filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const paid = filtered.reduce((sum, payment) =>
    sum + (payment.status === 'Pagato' ? Number(payment.amount) : 0), 0);
  $('report-count').textContent = String(filtered.length);
  $('report-total').textContent = formatAmount(total);
  $('report-paid').textContent = formatAmount(paid);
  $('report-pending').textContent = String(filtered.filter(payment => payment.status === 'In Attesa').length);
  $('report-empty').hidden = filtered.length > 0;
  $('report-list').innerHTML = filtered.map(payment => {
    const statusClass = { 'In Attesa': 'pending', 'Pagato': 'paid', 'Annullato': 'cancelled' }[payment.status] || 'pending';
    const bookingName = payment.eventTitle || (payment.eventId ? 'Appuntamento collegato' : 'Inserimento manuale');
    return `<tr>
      <td>${escapeHtml(formatDateTime(payment.examDate))}</td>
      <td>${escapeHtml(payment.clientEmail)}</td>
      <td>${escapeHtml(bookingName)}</td>
      <td class="amount-cell">${escapeHtml(formatAmount(payment.amount))}</td>
      <td><span class="status-badge ${statusClass}">${escapeHtml(payment.status)}</span></td>
    </tr>`;
  }).join('');
}
async function loadReportsPage() {
  $('report-list').innerHTML = '';
  $('report-empty').hidden = false;
  $('report-empty').textContent = 'Caricamento del report…';
  const [paymentResult, clientResult] = await Promise.allSettled([
    api('/api/payments'),
    api('/api/clients')
  ]);
  if (paymentResult.status === 'rejected') {
    $('report-empty').textContent = 'Impossibile caricare i dati del report.';
    toast(paymentResult.reason.message);
    return;
  }
  reportPayments = paymentResult.value;
  const clientSelect = $('report-client');
  clientSelect.innerHTML = '<option value="">Tutti i clienti</option>';
  if (clientResult.status === 'fulfilled') {
    clientResult.value.forEach(client => {
      const option = document.createElement('option');
      option.value = client.email;
      option.textContent = client.name ? `${client.name} · ${client.email}` : client.email;
      clientSelect.appendChild(option);
    });
  } else {
    toast(`Impossibile caricare l'elenco clienti: ${clientResult.reason.message}`);
  }
  renderReports();
}
function beginNewClient() {
  selectedClientEmail = '';
  renderClientList();
  renderClientProfile(null, true);
  $('client-profile-email').focus();
}
function openNewEvent(selection) {
  $('event-form').reset(); $('event-id').value = ''; $('dialog-title').textContent = 'Nuovo appuntamento';
  $('delete-event').hidden = true; $('form-error').textContent = '';
  const start = selection?.start || new Date();
  const end = selection?.end || new Date(start.getTime() + 60 * 60 * 1000);
  $('start').value = toLocalInput(start); $('end').value = toLocalInput(end);
  dialog.showModal();
}
function openExistingEvent(event) {
  $('event-form').reset(); $('event-id').value = event.id; $('dialog-title').textContent = 'Modifica appuntamento';
  $('delete-event').hidden = false; $('form-error').textContent = '';
  $('title').value = event.title; $('start').value = toLocalInput(event.start); $('end').value = toLocalInput(event.end);
  $('client-email').value = event.extendedProps.clientEmail || '';
  $('description').value = event.extendedProps.description || ''; $('location').value = event.extendedProps.location || '';
  dialog.showModal();
}


async function loadCalendar(user, mode, calendarConfigured, googleSyncEnabled, calendarConnected) {
  $('signed-out').hidden = true;
  $('calendar-panel').hidden = false;
  $('welcome-connect').hidden = true;

  if (mode === 'local') {
    $('account').textContent = 'Modalità locale';
    $('calendar-setup').hidden = !googleSyncEnabled || !calendarConnected || calendarConfigured;
    if (googleSyncEnabled) {
      $('connection').textContent = calendarConnected
        ? `Google Calendar collegato come ${user.email || 'account Google'}`
        : 'Google Calendar non collegato. Gli appuntamenti restano salvati in locale.';
      $('welcome-connect').hidden = false;
      $('welcome-connect').textContent = calendarConnected
        ? 'Cambia account Google Calendar'
        : 'Collega Google Calendar';
    } else {
      $('connection').textContent = 'Dati salvati in locale. Google non è collegato.';
    }
  } else {
    $('account').textContent = `Accesso IAP · ${user.email || 'utente autorizzato'}`;
    $('connection').textContent = calendarConnected
      ? `Google Calendar collegato come ${user.calendarEmail || user.email}`
      : 'App protetta da IAP. Collega Google Calendar per sincronizzare gli appuntamenti.';
    $('calendar-setup').hidden = !calendarConnected || calendarConfigured;
    $('welcome-connect').hidden = false;
    $('welcome-connect').textContent = calendarConnected
      ? 'Cambia connessione Google Calendar'
      : 'Collega Google Calendar';
  }

  calendar = new FullCalendar.Calendar($('calendar'), {
    initialView: 'dayGridMonth',
    height: 'auto',
    firstDay: 1,
    locale: 'it',
    buttonText: {
      prev: 'precedente',
      next: 'successivo',
      today: 'oggi',
      month: 'mese',
      week: 'settimana',
      day: 'giorno'
    },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    nowIndicator: true,

    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay'
    },

    selectable: true,
    selectMirror: true,
    editable: false,
    dayMaxEvents: true,

    events: async (info, success, failure) => {
      try {
        const query = new URLSearchParams({
          start: info.start.toISOString(),
          end: info.end.toISOString()
        });

        const events = await api(`/api/events?${query}`);
        const syncFailure = events.find(event => event.syncError);
        if (syncFailure) toast(syncFailure.syncError);

        success(events.map(e => ({
          id: e.id,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          extendedProps: {
            clientEmail: e.clientEmail,
            description: e.description,
            location: e.location,
            htmlLink: e.htmlLink
          }
        })));

      } catch (error) {
        failure(error);
        toast(error.message);
      }
    },

    select: info => openNewEvent({
      start: info.start,
      end: info.end
    }),

    dateClick: info => openNewEvent({
      start: info.date,
      end: new Date(info.date.getTime() + 3600000)
    }),

    eventClick: info => {
      info.jsEvent.preventDefault();
      openExistingEvent(info.event);
    }
  });

  calendar.render();
}


function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
$('event-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('form-error').textContent = '';
  const id = $('event-id').value;
  const payload = {
    title: $('title').value,
    clientEmail: $('client-email').value.trim(),
    start: new Date($('start').value).toISOString(),
    end: new Date($('end').value).toISOString(),
    description: $('description').value,
    location: $('location').value
  };
  try {
    const saved = await api(id ? `/api/events/${encodeURIComponent(id)}` : '/api/events', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    dialog.close(); calendar.refetchEvents();
    toast(saved.syncError
      ? `Salvato in locale; sincronizzazione Google in sospeso: ${saved.syncError}`
      : (id ? 'Appuntamento aggiornato' : 'Appuntamento creato'));
  } catch (error) { $('form-error').textContent = error.message; }
});
$('calendar-setup').addEventListener('click', async () => {
  try {
    const result = await api('/api/events/google-calendar', { method: 'POST' });
    $('calendar-setup').hidden = true;
    window.alert(
      `Calendario "${result.calendarName}" ${result.created ? 'creato' : 'già esistente'}.\n\n` +
      `Aggiungi questa riga al file .env e riavvia l'app:\nGOOGLE_CALENDAR_ID=${result.calendarId}`
    );
  } catch (error) {
    toast(error.message);
  }
});
$('delete-event').addEventListener('click', async () => {
  const id = $('event-id').value; if (!id || !confirm('Vuoi eliminare questo appuntamento?')) return;
  try { await api(`/api/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); dialog.close(); calendar.refetchEvents(); toast('Appuntamento eliminato'); }
  catch (error) { $('form-error').textContent = error.message; }
});
$('close-dialog').addEventListener('click', () => dialog.close());
$('cancel-dialog').addEventListener('click', () => dialog.close());
$('menu-toggle').addEventListener('click', toggleMenu);
$('menu-scrim').addEventListener('click', closeMenu);
$('open-calendar').addEventListener('click', () => showView('calendar'));
$('payment-booking').addEventListener('change', () => {
  const booking = bookingRecords.get($('payment-booking').value);
  const dateInput = $('payment-exam-date');
  if (booking) {
    dateInput.value = toLocalInput(booking.start);
    dateInput.readOnly = true;
  } else {
    dateInput.readOnly = false;
  }
});
$('payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('payment-form-error').textContent = '';
  const selectedBooking = $('payment-booking').value;
  const date = $('payment-exam-date').value;
  const payload = {
    clientEmail: $('payment-client-email').value.trim(),
    amount: Number($('payment-amount').value),
    eventId: selectedBooking || null,
    examDate: date ? new Date(date).toISOString() : '',
    status: $('payment-status').value
  };

  try {
    await api('/api/payments', { method: 'POST', body: JSON.stringify(payload) });
    $('payment-form').reset();
    $('payment-exam-date').readOnly = false;
    $('payment-exam-date').value = toLocalInput(new Date());
    await loadPaymentsPage();
    toast('Pagamento registrato');
  } catch (error) {
    $('payment-form-error').textContent = error.message;
  }
});
$('client-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-client-email]');
  if (button) selectClient(button.dataset.clientEmail);
});
$('client-search').addEventListener('input', renderClientList);
$('add-client').addEventListener('click', beginNewClient);
$('report-reset').addEventListener('click', () => {
  $('report-from').value = '';
  $('report-to').value = '';
  $('report-client').value = '';
  $('report-status').value = '';
  renderReports();
});
['report-from', 'report-to', 'report-client', 'report-status'].forEach(id => {
  $(id).addEventListener('change', renderReports);
});
$('client-profile-detail').addEventListener('submit', async (event) => {
  if (event.target.id !== 'client-profile-form') return;
  event.preventDefault();
  const email = $('client-profile-email').value.trim().toLowerCase();
  const feedback = $('client-profile-feedback');
  feedback.textContent = '';

  try {
    await api(`/api/clients/${encodeURIComponent(email)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('client-profile-name').value,
        phone: $('client-profile-phone').value,
        notes: $('client-profile-notes').value
      })
    });
    toast('Scheda cliente salvata');
    await loadClientsPage(email);
  } catch (error) {
    feedback.textContent = error.message;
  }
});
document.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', () => showView(item.dataset.view));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});


(async function init() {
  try {
    const me = await api('/api/me');

    if (me.authenticated || me.mode === 'local') {
      csrfToken = me.csrfToken || '';
      document.querySelector('[data-view="payments"]').hidden = false;
      document.querySelector('[data-view="clients"]').hidden = false;
      document.querySelector('[data-view="reports"]').hidden = false;
      document.querySelector('[data-view="reports"]').hidden = false;
      await loadCalendar(
        me.user || {},
        me.mode,
        me.calendarConfigured,
        me.googleSyncEnabled,
        me.calendarConnected
      );
    } else {
      $('signed-out').hidden = false;
      $('calendar-panel').hidden = true;
      $('account').textContent = '';
      $('welcome-connect').hidden = false;
      document.querySelector('[data-view="payments"]').hidden = true;
      document.querySelector('[data-view="clients"]').hidden = true;
      document.querySelector('[data-view="reports"]').hidden = true;
      document.querySelector('[data-view="reports"]').hidden = true;
    }
    showView('welcome');

    const params = new URLSearchParams(location.search);

    if (params.has('error')) {
      toast('Accesso con Google annullato o non autorizzato.');
    }

    history.replaceState({}, '', '/');

  } catch (error) {
    toast(error.message);
    console.error('Initialization error:', error);
  }
})();

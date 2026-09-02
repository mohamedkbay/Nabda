import { CONTACT_FILE_MAX_BYTES, CONTACT_IMPORT_BATCH_SIZE, contactsFromFile } from "/contact-import.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const headers = { "content-type": "application/json", "x-nabda-control": "1" };
const pageTitles = { dashboard: "Overview", messages: "Messages", contacts: "Contacts", campaigns: "Campaigns", device: "Device" };
let state = null;
let pendingContactImport = [];
let pairingTimer = null;

function renderIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3400);
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...headers, ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function date(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function relativeDate(value) {
  if (!value) return "Never";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return date(value);
}

function status(value) {
  const safeClass = String(value).replace(/[^a-z-]/g, "");
  return `<span class="status ${safeClass}">${escapeHtml(value)}</span>`;
}

function showView(name) {
  if (!pageTitles[name]) return;
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#page-title").textContent = pageTitles[name];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function contactRows(contacts) {
  return contacts.map((contact) => `<tr>
    <td>${escapeHtml(contact.name)}</td>
    <td>${escapeHtml(contact.phone)}</td>
    <td>${escapeHtml(contact.consent_reference || "—")}</td>
    <td>${contact.opted_out ? status("opted-out") : status("active")}</td>
    <td><button class="table-action" data-optout="${contact.id}" data-value="${!contact.opted_out}">${contact.opted_out ? "Restore" : "Stop"}</button></td>
  </tr>`).join("");
}

function renderContactsTable() {
  if (!state) return;
  const query = $("#contact-search").value.trim().toLowerCase();
  const contacts = state.contacts.filter((contact) => !query || `${contact.name} ${contact.phone}`.toLowerCase().includes(query));
  $("#contacts-table").innerHTML = contactRows(contacts);
  $("#contacts-empty").hidden = state.contacts.length > 0;
}

function render() {
  const { system, device, counts, contacts, messages } = state;
  $("#system-label").textContent = "Controller running";
  $("#status-detail").textContent = device?.last_seen_at ? "Android phone is connected" : "Local data stays on this computer";
  $("#service-status .pulse").className = `pulse ${device?.last_seen_at ? "" : "checking"}`.trim();
  $("#lan-url").textContent = system.lan_url;
  $("#device-url").textContent = system.lan_url;
  $("#live-state").textContent = system.live_enabled ? "Enabled" : "Locked";
  $("#live-checkbox").checked = system.live_enabled;
  $("#used-count").textContent = system.monthly_used.toLocaleString();
  $("#usage-left").textContent = Math.max(0, system.monthly_limit - system.monthly_used).toLocaleString();
  $("#usage-meter").style.width = `${Math.min(100, system.monthly_used / system.monthly_limit * 100)}%`;
  $("#queued-count").textContent = counts.queued.toLocaleString();
  $("#sent-count").textContent = counts.sent.toLocaleString();
  $("#failed-count").textContent = counts.failed.toLocaleString();
  $("#contacts-count").textContent = counts.contacts.toLocaleString();
  $("#contacts-list-count").textContent = counts.contacts.toLocaleString();
  $("#last-seen").textContent = relativeDate(device?.last_seen_at);
  $("#device-last-seen").textContent = relativeDate(device?.last_seen_at);
  $("#device-name-display").textContent = device?.name || "No phone paired";
  $("#device-status-detail").textContent = device?.last_seen_at ? "Connected and checking the queue" : device ? "Paired, waiting for the agent" : "Waiting for QR pairing";
  $("#phone-visual-status").textContent = device?.last_seen_at ? "Connected to the local queue" : device ? "Paired · waiting for heartbeat" : "Waiting for QR pairing";
  $("#device-chip").textContent = device?.last_seen_at ? "Connected" : device ? "Paired" : "Not paired";
  $("#device-chip").classList.toggle("connected", Boolean(device?.last_seen_at));
  $("#device-pulse").className = `pulse ${device?.last_seen_at ? "" : "offline"}`.trim();

  const options = contacts.filter((contact) => !contact.opted_out).map((contact) => `<option value="${contact.id}" data-phone="${escapeHtml(contact.phone)}">${escapeHtml(contact.name)} · ${escapeHtml(contact.phone)}</option>`).join("");
  const selectedContact = $("#message-contact").value;
  $("#message-contact").innerHTML = '<option value="">Enter a number manually</option>' + options;
  if ([...$("#message-contact").options].some((option) => option.value === selectedContact)) $("#message-contact").value = selectedContact;

  $("#quick-contacts").innerHTML = contacts.slice(0, 5).map((contact) => `<div class="quick-contact"><span class="contact-avatar">${escapeHtml(contact.name.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(contact.name)}</strong><small>${escapeHtml(contact.phone)}</small></span>${contact.opted_out ? status("stopped") : ""}</div>`).join("") || '<div class="empty-state"><strong>No contacts yet</strong><span>Import your CSV to begin.</span></div>';

  $("#dashboard-activity").innerHTML = messages.slice(0, 5).map((message) => `<div class="activity-row"><span class="activity-icon"><i data-lucide="${["sent", "delivered"].includes(message.status) ? "check" : message.status === "failed" ? "triangle-alert" : "clock-3"}"></i></span><span><strong>${escapeHtml(message.to)}</strong><small>${escapeHtml(message.content.length > 42 ? `${message.content.slice(0, 39)}…` : message.content)}</small></span><time>${relativeDate(message.created_at)}</time></div>`).join("") || '<div class="empty-state"><strong>Your queue is quiet</strong><span>New activity will appear here.</span></div>';

  $("#messages-table").innerHTML = messages.map((message) => `<tr><td>${escapeHtml(message.to)}</td><td>${escapeHtml(message.content.length > 80 ? `${message.content.slice(0, 77)}…` : message.content)}</td><td>${status(message.status)}</td><td>${date(message.created_at)}</td><td>${message.status === "queued" ? `<button class="table-action" data-cancel="${message.id}">Cancel</button>` : ""}</td></tr>`).join("");
  $("#messages-empty").hidden = messages.length > 0;
  renderContactsTable();

  $("#campaign-contacts").innerHTML = contacts.filter((contact) => !contact.opted_out).map((contact) => `<label class="contact-option"><input type="checkbox" name="contact_ids" value="${contact.id}" /><span>${escapeHtml(contact.name)}<small>${escapeHtml(contact.phone)}</small></span></label>`).join("") || '<p class="empty-copy">Save contacts first.</p>';
  renderIcons();
}

async function refresh() {
  try {
    state = await request("/control-api/state");
    render();
  } catch (error) {
    toast(error.message);
  }
}

function startPairingCountdown(expiresAt) {
  clearInterval(pairingTimer);
  const update = () => {
    const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    $("#pairing-expiry").textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Expired — create a new code";
    $("#pairing-state").textContent = seconds ? "Waiting for scan" : "Expired";
    if (!seconds) clearInterval(pairingTimer);
  };
  update();
  pairingTimer = setInterval(update, 1000);
}

$("#message-contact").addEventListener("change", (event) => {
  const option = event.target.selectedOptions[0];
  if (option?.dataset.phone) $("#message-phone").value = option.dataset.phone;
});

$("#message-content").addEventListener("input", (event) => {
  $("#character-count").textContent = `${event.target.value.length} / 160`;
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await request("/control-api/messages", { method: "POST", body: JSON.stringify({ contact_id: data.get("contact_id") || undefined, to: data.get("to"), content: data.get("content"), send_at: data.get("send_at") || undefined, consent_confirmed: data.get("consent") === "on" }) });
    event.currentTarget.reset();
    $("#character-count").textContent = "0 / 160";
    toast("Message added to the local queue.");
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#contact-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await request("/control-api/contacts", { method: "POST", body: JSON.stringify({ name: data.get("name"), phone: data.get("phone"), consent_reference: data.get("consent_reference"), consent_confirmed: data.get("consent") === "on" }) });
    event.currentTarget.reset();
    toast("Contact saved locally.");
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#contact-import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  pendingContactImport = [];
  $("#contact-import-button").disabled = true;
  if (!file) return $("#contact-import-result").textContent = "No file selected.";
  if (file.size > CONTACT_FILE_MAX_BYTES) return $("#contact-import-result").textContent = "The file is larger than 15 MB.";
  try {
    pendingContactImport = contactsFromFile(await file.text(), file.name);
    $("#contact-import-result").textContent = pendingContactImport.length
      ? `Ready: found ${pendingContactImport.length.toLocaleString()} unique names and numbers.`
      : "No readable names and phone numbers were found.";
    $("#contact-import-button").disabled = pendingContactImport.length < 1;
  } catch { $("#contact-import-result").textContent = "The file could not be read."; }
});

$("#contact-import-button").addEventListener("click", async () => {
  const reference = $("#contact-import-reference").value.trim();
  if (!reference) return toast("Add the consent source for this contact list.");
  if (!$("#contact-import-consent").checked) return toast("Confirm that every person expects these messages.");
  if (!pendingContactImport.length) return toast("Choose a contact file first.");
  const button = $("#contact-import-button");
  button.disabled = true;
  const totals = { imported: 0, duplicates: 0, invalid: 0 };
  try {
    for (let start = 0; start < pendingContactImport.length; start += CONTACT_IMPORT_BATCH_SIZE) {
      const batch = pendingContactImport.slice(start, start + CONTACT_IMPORT_BATCH_SIZE);
      $("#contact-import-result").textContent = `Importing ${Math.min(start + batch.length, pendingContactImport.length).toLocaleString()} of ${pendingContactImport.length.toLocaleString()}…`;
      const result = await request("/control-api/contacts/import", { method: "POST", body: JSON.stringify({ contacts: batch, consent_reference: reference, consent_confirmed: true }) });
      totals.imported += result.imported;
      totals.duplicates += result.duplicates;
      totals.invalid += result.invalid;
    }
    $("#contact-import-result").textContent = `Done: ${totals.imported.toLocaleString()} added, ${totals.duplicates.toLocaleString()} duplicates, ${totals.invalid.toLocaleString()} invalid.`;
    $("#contact-import-file").value = "";
    pendingContactImport = [];
    toast(`${totals.imported.toLocaleString()} contacts imported.`);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = pendingContactImport.length < 1;
  }
});

$("#contact-search").addEventListener("input", renderContactsTable);

$("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const result = await request("/control-api/campaigns", { method: "POST", body: JSON.stringify({ name: data.get("name"), content: data.get("content"), send_at: data.get("send_at") || undefined, contact_ids: data.getAll("contact_ids"), consent_confirmed: data.get("consent") === "on" }) });
    event.currentTarget.reset();
    toast(`Campaign queued: ${result.queued} messages, ${result.skippedOptOut} stopped.`);
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#create-pairing").addEventListener("click", async () => {
  try {
    const pairing = await request("/control-api/pairing", { method: "POST", body: JSON.stringify({ name: $("#device-name").value }) });
    if (typeof window.qrcode !== "function") throw new Error("QR generator is unavailable.");
    const qr = window.qrcode(0, "M");
    qr.addData(pairing.pairing_uri);
    qr.make();
    $("#pairing-qr").src = qr.createDataURL(7, 4);
    $("#pairing-panel").classList.remove("hidden");
    startPairingCountdown(pairing.expires_at);
    toast("One-time QR created. Scan it with Nabda Agent.");
  } catch (error) { toast(error.message); }
});

$("#save-live").addEventListener("click", async () => {
  try {
    const enabled = $("#live-checkbox").checked;
    await request("/control-api/live", { method: "POST", body: JSON.stringify({ enabled, confirmation: $("#live-confirmation").value }) });
    $("#live-confirmation").value = "";
    toast(enabled ? "Carrier sending enabled." : "Carrier sending locked.");
    await refresh();
  } catch (error) { toast(error.message); }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  if (target.dataset.view) return showView(target.dataset.view);
  if (target.dataset.viewTarget) return showView(target.dataset.viewTarget);
  try {
    if (target.matches("[data-refresh]")) await refresh();
    if (target.dataset.cancel) {
      await request(`/control-api/messages/${target.dataset.cancel}/cancel`, { method: "POST", body: "{}" });
      toast("Queued message cancelled.");
      await refresh();
    }
    if (target.dataset.optout) {
      await request(`/control-api/contacts/${target.dataset.optout}/opt-out`, { method: "POST", body: JSON.stringify({ opted_out: target.dataset.value === "true" }) });
      toast("Recipient state updated.");
      await refresh();
    }
  } catch (error) { toast(error.message); }
});

renderIcons();
refresh();
setInterval(refresh, 5000);

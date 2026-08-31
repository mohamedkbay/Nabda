"use strict";

const api = window.httpSmsDesktop;
const pageTitles = {
  dashboard: "لوحة التحكم",
  customers: "العملاء",
  contacts: "جهات الاتصال",
  campaigns: "الحملات",
  messages: "الرسائل",
  integration: "إعداد httpSMS",
  backup: "النسخ الاحتياطي",
};
const statusLabels = {
  queued: "في الطابور",
  sent: "أُرسلت",
  delivered: "تم التسليم",
  failed: "فشلت",
  expired: "انتهت",
  cancelled: "ملغاة",
  connected: "متصل",
  offline: "غير متصل",
  revoked: "ملغى",
};

let activePage = "dashboard";
let customers = [];
let contacts = [];
let statusPollTimer;
let encryptedDefault = false;

document.addEventListener("DOMContentLoaded", () => {
  renderIcons();
  bindNavigation();
  bindDialogs();
  bindForms();
  bindSettings();
  bindCampaigns();
  bindStatusRefresh();
  bindBackup();
  document.querySelector("#refresh-page").addEventListener("click", () => void loadPage(activePage));
  void loadPage("dashboard");
});

function bindNavigation() {
  document.querySelectorAll("[data-page]").forEach((button) =>
    button.addEventListener("click", () => navigate(button.dataset.page)),
  );
  document.querySelectorAll("[data-go]").forEach((button) =>
    button.addEventListener("click", () => navigate(button.dataset.go)),
  );
}

function navigate(page) {
  if (!pageTitles[page]) return;
  activePage = page;
  clearInterval(statusPollTimer);
  document.querySelectorAll(".page").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((element) => element.classList.remove("active"));
  document.querySelector(`#page-${page}`).classList.add("active");
  document.querySelector(`[data-page="${page}"]`).classList.add("active");
  document.querySelector("#page-title").textContent = pageTitles[page];
  void loadPage(page);
  if (page === "messages") void startStatusPolling();
}

async function loadPage(page) {
  try {
    if (page === "dashboard") await loadDashboard();
    if (page === "customers") await loadCustomers();
    if (page === "contacts") await loadContacts();
    if (page === "campaigns") await loadCampaigns();
    if (page === "messages") await loadMessages();
    if (page === "integration") await loadSettings();
  } catch {
    toast("تعذّر تحميل البيانات المحلية.", true);
  }
}

async function loadDashboard() {
  const snapshot = await api.dashboard.get();
  setText("metric-customers", snapshot.customers);
  setText("metric-contacts", snapshot.contacts);
  setText("metric-queued", snapshot.queuedMessages);
  setText("metric-integration", snapshot.integrationConfigured ? "جاهز" : "إعداد");
  const list = document.querySelector("#recent-messages");
  clear(list);
  if (!snapshot.recentMessages.length) return empty(list, "لا توجد رسائل بعد.");
  snapshot.recentMessages.forEach((message) => {
    const row = node("div", "activity-row");
    const person = node("div");
    person.append(node("strong", "", message.contactName || message.to), node("small", "", message.bodyPreview));
    row.append(person, statusPill(message.status), node("small", "", formatDate(message.createdAt)));
    list.append(row);
  });
  renderIcons();
}

async function loadCustomers() {
  customers = await api.customers.list();
  const body = document.querySelector("#customers-table");
  clear(body);
  toggleEmpty("customers-empty", customers.length === 0);
  customers.forEach((customer) => {
    const row = node("tr");
    [customer.name, customer.phone || "—", customer.notes || "—", formatDate(customer.createdAt)].forEach((value) =>
      row.append(cell(value)),
    );
    body.append(row);
  });
  fillCustomerSelect();
}

async function loadContacts() {
  contacts = await api.contacts.list();
  const body = document.querySelector("#contacts-table");
  clear(body);
  toggleEmpty("contacts-empty", contacts.length === 0);
  contacts.forEach((contact) => {
    const row = node("tr");
    row.append(cell(contact.name), cell(contact.phone), cell(contact.customerName || "—"));
    const stateCell = node("td");
    stateCell.append(statusPill(contact.optedOut ? "opted-out" : "connected", contact.optedOut ? "قائمة الإيقاف" : "نشط"));
    const actionCell = node("td");
    const toggle = buttonWithIcon(
      contact.optedOut ? "إلغاء الإيقاف" : "إضافة للإيقاف",
      contact.optedOut ? "link" : "unlink",
    );
    toggle.addEventListener("click", async () => {
      try {
        await api.contacts.setOptOut({ id: contact.id, optedOut: !contact.optedOut });
        toast(contact.optedOut ? "أُعيد تفعيل جهة الاتصال." : "أُضيفت جهة الاتصال لقائمة الإيقاف.");
        await loadContacts();
      } catch {
        toast("تعذّر تحديث قائمة الإيقاف.", true);
      }
    });
    actionCell.append(toggle);
    row.append(stateCell, actionCell);
    body.append(row);
  });
  renderIcons();
  fillContactSelect();
}

async function loadMessages() {
  const messages = await api.messages.list({ limit: 200 });
  const body = document.querySelector("#messages-table");
  clear(body);
  toggleEmpty("messages-empty", messages.length === 0);
  messages.forEach((message) => {
    const row = node("tr");
    row.append(cell(message.contactName || message.to), cell(message.bodyPreview));
    const stateCell = node("td");
    stateCell.append(statusPill(message.status));
    row.append(stateCell, cell(formatDate(message.createdAt)));
    const actionCell = node("td");
    if (message.status === "queued") {
      const cancel = buttonWithIcon("إلغاء", "x");
      cancel.addEventListener("click", async () => {
        try {
          await api.messages.cancel({ id: message.id });
          toast("أُلغيت الرسالة من الطابور.");
          await loadMessages();
        } catch {
          toast("تعذّر إلغاء الرسالة.", true);
        }
      });
      actionCell.append(cancel);
    }
    row.append(actionCell);
    body.append(row);
  });
  renderIcons();
}

async function loadCampaigns() {
  if (!contacts.length) contacts = await api.contacts.list();
  const eligible = contacts.filter((contact) => !contact.optedOut);
  const contactList = document.querySelector("#campaign-contacts");
  clear(contactList);
  if (!eligible.length) empty(contactList, "أضف جهات اتصال نشطة أولًا.");
  eligible.forEach((contact) => {
    const label = node("label", "campaign-contact");
    const input = node("input");
    input.type = "checkbox";
    input.name = "contactIds";
    input.value = contact.id;
    label.append(input, document.createTextNode(`${contact.name} · ${contact.phone}`));
    contactList.append(label);
  });

  const campaigns = await api.campaigns.list();
  const list = document.querySelector("#campaigns-list");
  clear(list);
  if (!campaigns.length) return empty(list, "لا توجد حملات بعد.");
  const labels = { scheduled: "مجدولة", running: "قيد التنفيذ", completed: "مكتملة", attention: "تحتاج متابعة" };
  campaigns.forEach((campaign) => {
    const item = node("div", "campaign-item");
    const head = node("div", "campaign-item-head");
    head.append(node("strong", "", campaign.name), statusPill(campaign.status, labels[campaign.status]));
    const meta = node("p", "", `${campaign.recipientCount} مستلم · تبدأ ${formatDate(campaign.startsAt)}`);
    const counts = node("div", "campaign-counts");
    counts.append(
      node("span", "", `${campaign.queuedCount} في الطابور`),
      node("span", "", `${campaign.sentCount} مرسلة`),
      node("span", "", `${campaign.failedCount} فشلت`),
    );
    item.append(head, meta, counts);
    list.append(item);
  });
}

function bindDialogs() {
  document.querySelectorAll("[data-dialog]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (button.dataset.dialog === "contact-dialog" && !customers.length) await loadCustomers();
      if (button.dataset.dialog === "message-dialog" && !contacts.length) await loadContacts();
      if (button.dataset.dialog === "message-dialog") {
        document.querySelector("#message-encrypted").checked = encryptedDefault;
      }
      document.querySelector(`#${button.dataset.dialog}`).showModal();
    }),
  );
}

function bindForms() {
  document.querySelector("#submit-customer").addEventListener("click", async () => {
    const form = document.querySelector("#customer-form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const input = compact({ name: data.get("name"), phone: data.get("phone"), notes: data.get("notes") });
    try {
      await api.customers.create(input);
      form.reset();
      document.querySelector("#customer-dialog").close();
      toast("تم حفظ العميل محليًا.");
      await loadCustomers();
    } catch {
      toast("تعذّر حفظ العميل.", true);
    }
  });

  document.querySelector("#submit-contact").addEventListener("click", async () => {
    const form = document.querySelector("#contact-form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const input = compact({
      name: data.get("name"),
      phone: data.get("phone"),
      customerId: data.get("customerId"),
      consentConfirmed: true,
    });
    try {
      await api.contacts.create(input);
      form.reset();
      document.querySelector("#contact-dialog").close();
      toast("تم حفظ جهة الاتصال.");
      await loadContacts();
    } catch {
      toast("تعذّر حفظ جهة الاتصال.", true);
    }
  });

  document.querySelector("#message-contact").addEventListener("change", (event) => {
    const selected = contacts.find((contact) => contact.id === event.target.value);
    document.querySelector("#message-to").value = selected?.phone || "";
  });
  document.querySelector("#submit-message").addEventListener("click", async () => {
    const form = document.querySelector("#message-form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const sendAtValue = data.get("sendAt");
    const input = compact({
      contactId: data.get("contactId"),
      to: data.get("to"),
      body: data.get("body"),
      sendAt: sendAtValue ? new Date(sendAtValue).toISOString() : undefined,
      encrypted: data.get("encrypted") === "on",
      requestId: data.get("requestId"),
      consentConfirmed: true,
    });
    try {
      await api.messages.enqueue(input);
      form.reset();
      document.querySelector("#message-dialog").close();
      toast("أُضيفت الرسالة إلى الطابور المحلي.");
      await loadMessages();
    } catch {
      toast("رُفضت الرسالة. تحقق من البيانات وقائمة الإيقاف.", true);
    }
  });
}

function bindSettings() {
  const secret = document.querySelector("#provider-secret");
  const toggleSecret = document.querySelector("#toggle-secret");
  toggleSecret.addEventListener("click", () => {
    secret.type = secret.type === "password" ? "text" : "password";
    const visible = secret.type === "text";
    toggleSecret.replaceChildren();
    const icon = node("i");
    icon.setAttribute("data-lucide", visible ? "eye-off" : "eye");
    toggleSecret.append(icon);
    toggleSecret.setAttribute("aria-label", visible ? "إخفاء المفتاح" : "إظهار المفتاح");
    toggleSecret.title = visible ? "إخفاء المفتاح" : "إظهار المفتاح";
    renderIcons();
  });
  document.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = settingsInput();
    try {
      const saved = await api.settings.save(input);
      secret.value = "";
      document.querySelector("#clear-secret").checked = false;
      updateSecretStatus(saved.secretConfigured);
      toast("حُفظت الإعدادات بأمان.");
    } catch {
      toast("تعذّر حفظ الإعدادات أو تشفير المفتاح.", true);
    }
  });
  document.querySelector("#test-provider").addEventListener("click", async () => {
    const resultElement = document.querySelector("#provider-test-result");
    try {
      const result = await api.settings.testProvider();
      resultElement.textContent = `${result.ok ? "نجح" : "فشل"}: ${result.message} — لم تُرسل أي SMS.`;
      resultElement.className = `inline-result${result.ok ? "" : " error"}`;
    } catch {
      resultElement.textContent = "تعذّر اختبار الاتصال. لم تُرسل أي SMS.";
      resultElement.className = "inline-result error";
    }
  });
}

async function loadSettings() {
  const settings = await api.settings.get();
  document.querySelector("#sender-from").value = settings.from || "";
  document.querySelector("#encrypted-default").checked = settings.encryptedDefault;
  document.querySelector("#status-polling").value = String(settings.statusPollingSeconds);
  encryptedDefault = settings.encryptedDefault;
  updateSecretStatus(settings.secretConfigured);
}

function settingsInput() {
  return compact({
    from: document.querySelector("#sender-from").value,
    encryptedDefault: document.querySelector("#encrypted-default").checked,
    statusPollingSeconds: Number(document.querySelector("#status-polling").value),
    secret: document.querySelector("#provider-secret").value,
    clearSecret: document.querySelector("#clear-secret").checked || undefined,
  });
}

function updateSecretStatus(configured) {
  setText("secret-status", configured ? "يوجد مفتاح مشفّر محفوظ في هذا الجهاز." : "لا يوجد مفتاح محفوظ.");
}

function bindCampaigns() {
  document.querySelector("#campaign-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const startsAt = data.get("startsAt");
    const contactIds = [...form.querySelectorAll('input[name="contactIds"]:checked')].map((item) => item.value);
    if (!contactIds.length) return toast("اختر مستلمًا واحدًا على الأقل.", true);
    try {
      await api.campaigns.create({
        name: data.get("name"),
        body: data.get("body"),
        contactIds,
        startsAt: new Date(startsAt).toISOString(),
        messagesPerMinute: Number(data.get("messagesPerMinute")),
        encrypted: data.get("encrypted") === "on",
        consentConfirmed: true,
      });
      form.reset();
      toast("أُنشئت الحملة وأضيف مستلموها إلى الطابور المحلي.");
      await loadCampaigns();
    } catch {
      toast("تعذّر إنشاء الحملة. تحقق من الموعد والمستلمين وقائمة الإيقاف.", true);
    }
  });
}

function bindStatusRefresh() {
  document.querySelector("#refresh-statuses").addEventListener("click", () => void refreshStatuses(false));
}

async function refreshStatuses(silent) {
  try {
    await api.messages.refreshStatuses({ limit: 200 });
    await loadMessages();
    if (!silent) toast("حُدّثت الحالات من httpSMS.");
  } catch {
    if (!silent) toast("تعذّر تحديث الحالات. احفظ Account API Key أولًا.", true);
  }
}

async function startStatusPolling() {
  try {
    const settings = await api.settings.get();
    clearInterval(statusPollTimer);
    statusPollTimer = setInterval(() => {
      if (activePage === "messages") void refreshStatuses(true);
    }, settings.statusPollingSeconds * 1_000);
  } catch {
    clearInterval(statusPollTimer);
  }
}

function bindBackup() {
  document.querySelector("#export-backup").addEventListener("click", async () => {
    try {
      const result = await api.backup.export();
      if (!result.cancelled) toast(result.message || "تم تصدير النسخة الاحتياطية.", !result.ok);
    } catch {
      toast("تعذّر تصدير النسخة الاحتياطية.", true);
    }
  });
  document.querySelector("#import-backup").addEventListener("click", async () => {
    try {
      const result = await api.backup.import();
      if (!result.cancelled) {
        toast(result.message || "تم استيراد النسخة الاحتياطية.", !result.ok);
        if (result.ok) await loadPage(activePage);
      }
    } catch {
      toast("رُفض ملف النسخة الاحتياطية أو تعذّر استيراده.", true);
    }
  });
}

function fillCustomerSelect() {
  const select = document.querySelector("#contact-customer");
  replaceOptions(select, "بدون عميل", customers.map((item) => ({ value: item.id, label: item.name })));
}

function fillContactSelect() {
  const select = document.querySelector("#message-contact");
  replaceOptions(
    select,
    "إدخال رقم يدوي",
    contacts.filter((item) => !item.optedOut).map((item) => ({ value: item.id, label: `${item.name} · ${item.phone}` })),
  );
}

function replaceOptions(select, firstLabel, options) {
  clear(select);
  const first = node("option", "", firstLabel);
  first.value = "";
  select.append(first);
  options.forEach((item) => {
    const option = node("option", "", item.label);
    option.value = item.value;
    select.append(option);
  });
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function buttonWithIcon(label, iconName) {
  const button = node("button", "secondary-button");
  button.type = "button";
  const icon = node("i");
  icon.setAttribute("data-lucide", iconName);
  button.append(icon, document.createTextNode(label));
  return button;
}

function renderIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

function cell(text) {
  return node("td", "", text);
}

function statusPill(status, label) {
  return node("span", `status-pill ${status}`, label || statusLabels[status] || status);
}

function clear(element) {
  element.replaceChildren();
  element.classList.remove("empty-state");
}

function empty(element, message) {
  element.classList.add("empty-state");
  element.textContent = message;
}

function toggleEmpty(id, visible) {
  document.querySelector(`#${id}`).classList.toggle("hidden", !visible);
}

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = String(value);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ar-LY", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function compact(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

let toastTimer;
function toast(message, isError = false) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.className = `toast visible${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 3500);
}

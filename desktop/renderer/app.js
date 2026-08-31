"use strict";

const api = window.nabdaDesktop;
const pageTitles = {
  dashboard: "لوحة التحكم",
  customers: "العملاء",
  contacts: "جهات الاتصال",
  messages: "الرسائل",
  devices: "الأجهزة",
  settings: "الإعدادات",
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
let pairingTimer;

document.addEventListener("DOMContentLoaded", () => {
  renderIcons();
  bindNavigation();
  bindDialogs();
  bindForms();
  bindDeviceActions();
  bindSettings();
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
  document.querySelectorAll(".page").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((element) => element.classList.remove("active"));
  document.querySelector(`#page-${page}`).classList.add("active");
  document.querySelector(`[data-page="${page}"]`).classList.add("active");
  document.querySelector("#page-title").textContent = pageTitles[page];
  void loadPage(page);
}

async function loadPage(page) {
  try {
    if (page === "dashboard") await loadDashboard();
    if (page === "customers") await loadCustomers();
    if (page === "contacts") await loadContacts();
    if (page === "messages") await loadMessages();
    if (page === "devices") await loadDevices();
    if (page === "settings") await loadSettings();
  } catch {
    toast("تعذّر تحميل البيانات المحلية.", true);
  }
}

async function loadDashboard() {
  const snapshot = await api.dashboard.get();
  setText("metric-customers", snapshot.customers);
  setText("metric-contacts", snapshot.contacts);
  setText("metric-queued", snapshot.queuedMessages);
  setText("metric-devices", snapshot.connectedDevices);
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

async function loadDevices() {
  const devices = await api.devices.list();
  const list = document.querySelector("#devices-list");
  clear(list);
  if (!devices.length) return empty(list, "لا توجد أجهزة مرتبطة.");
  devices.forEach((device) => {
    const item = node("div", "device-item");
    const head = node("div", "device-item-head");
    head.append(node("strong", "", device.name), statusPill(device.status));
    const meta = node("p", "", device.lastSeenAt ? `آخر اتصال: ${formatDate(device.lastSeenAt)}` : "لم يتصل بعد");
    const actions = node("div", "device-actions");
    const test = buttonWithIcon("اختبار Heartbeat", "activity");
    test.addEventListener("click", () => void testDevice(device.id));
    const rotate = buttonWithIcon("إعادة الاقتران", "rotate-cw");
    rotate.addEventListener("click", () => void rotateDevice(device.id));
    const revoke = buttonWithIcon("إلغاء الجهاز", "unlink");
    revoke.addEventListener("click", () => void revokeDevice(device.id));
    actions.append(test, rotate, revoke);
    item.append(head, meta, actions);
    list.append(item);
  });
  renderIcons();
}

function bindDialogs() {
  document.querySelectorAll("[data-dialog]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (button.dataset.dialog === "contact-dialog" && !customers.length) await loadCustomers();
      if (button.dataset.dialog === "message-dialog" && !contacts.length) await loadContacts();
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
    const input = compact({
      contactId: data.get("contactId"),
      to: data.get("to"),
      body: data.get("body"),
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

function bindDeviceActions() {
  document.querySelector("#new-pairing").addEventListener("click", () => void createPairing());
  document.querySelector("#copy-pairing").addEventListener("click", async () => {
    const address = document.querySelector("#pairing-address").textContent;
    const code = document.querySelector("#pairing-code").textContent;
    try {
      await navigator.clipboard.writeText(`${address}\n${code}`);
      toast("نُسخت بيانات الاقتران.");
    } catch {
      toast("تعذّر النسخ؛ أدخل العنوان والرمز يدويًا.", true);
    }
  });
}

async function createPairing() {
  const button = document.querySelector("#new-pairing");
  button.disabled = true;
  try {
    const session = await api.devices.createPairing();
    document.querySelector("#pairing-empty").classList.add("hidden");
    document.querySelector("#pairing-details").classList.remove("hidden");
    document.querySelector("#pairing-qr").src = session.qrDataUrl;
    setText("pairing-code", session.oneTimeCode);
    setText("pairing-address", session.manualAddress);
    startCountdown(session.expiresAt);
    toast("تم إنشاء رمز جديد صالح لخمس دقائق.");
  } catch {
    toast("تعذّر إنشاء الاقتران. تأكد من اتصال الكمبيوتر بشبكة Wi‑Fi خاصة.", true);
  } finally {
    button.disabled = false;
  }
}

function startCountdown(expiresAt) {
  clearInterval(pairingTimer);
  const update = () => {
    const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    setText("pairing-countdown", seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "انتهى الرمز");
    if (!seconds) {
      clearInterval(pairingTimer);
      document.querySelector("#pairing-qr").removeAttribute("src");
    }
  };
  update();
  pairingTimer = setInterval(update, 1000);
}

async function testDevice(id) {
  try {
    const result = await api.devices.testHeartbeat({ id });
    toast(result.message, !result.ok);
    await loadDevices();
  } catch {
    toast("لم يصل Heartbeat من الهاتف. لم تُرسل أي رسالة.", true);
  }
}

async function revokeDevice(id) {
  if (!window.confirm("إلغاء هذا الجهاز وتوكنه الدائم؟")) return;
  try {
    await api.devices.revoke({ id });
    toast("أُلغي وصول الجهاز.");
    await loadDevices();
  } catch {
    toast("تعذّر إلغاء الجهاز.", true);
  }
}

async function rotateDevice(id) {
  if (!window.confirm("سيُلغى توكن الجهاز الحالي، ثم يُنشأ رمز اقتران جديد. متابعة؟")) return;
  try {
    await api.devices.revoke({ id });
    await createPairing();
    await loadDevices();
    toast("أُلغي التوكن القديم. امسح QR الجديد لإكمال إعادة الاقتران.");
  } catch {
    toast("تعذّرت إعادة الاقتران. التوكن القديم قد يكون ملغى؛ أنشئ رمزًا جديدًا.", true);
  }
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
      const result = await api.settings.testProvider(compact({
        provider: document.querySelector("#provider").value,
        endpoint: document.querySelector("#provider-endpoint").value,
      }));
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
  document.querySelector("#provider").value = settings.provider;
  document.querySelector("#provider-endpoint").value = settings.providerEndpoint || "";
  document.querySelector("#sender-label").value = settings.senderLabel || "";
  document.querySelector("#worker-on-launch").checked = settings.startWorkerOnLaunch;
  updateSecretStatus(settings.secretConfigured);
}

function settingsInput() {
  return compact({
    provider: document.querySelector("#provider").value,
    providerEndpoint: document.querySelector("#provider-endpoint").value,
    senderLabel: document.querySelector("#sender-label").value,
    startWorkerOnLaunch: document.querySelector("#worker-on-launch").checked,
    secret: document.querySelector("#provider-secret").value,
    clearSecret: document.querySelector("#clear-secret").checked || undefined,
  });
}

function updateSecretStatus(configured) {
  setText("secret-status", configured ? "يوجد مفتاح مشفّر محفوظ في هذا الجهاز." : "لا يوجد مفتاح محفوظ.");
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

import { CONTACT_FILE_MAX_BYTES, CONTACT_IMPORT_BATCH_SIZE, contactsFromFile } from "/contact-import.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const headers = { "content-type": "application/json", "x-nabda-control": "1" };
const pageTitles = { dashboard: "Overview", messages: "Messages", contacts: "Contacts", device: "Device" };
const translations = {
  "LOCAL CONTROLLER": "وحدة التحكم المحلية", "Main navigation": "التنقل الرئيسي", Overview: "نظرة عامة", Messages: "الرسائل", Contacts: "جهات الاتصال", Campaigns: "الحملات", Device: "الجهاز", Language: "اللغة",
  "Starting controller": "جارٍ تشغيل وحدة التحكم", "Local data stays on this computer": "تبقى البيانات المحلية على هذا الكمبيوتر", "NABDA LOCAL WORKSPACE": "مساحة نبضة المحلية", Refresh: "تحديث",
  "THIS MONTH": "هذا الشهر", "Message center": "مركز الرسائل", "messages added to your queue": "رسالة أضيفت إلى الطابور", "available this month": "متاحة هذا الشهر", Waiting: "قيد الانتظار", Sent: "مُرسلة", "Needs review": "تحتاج مراجعة",
  "QUICK SEND": "إرسال سريع", "New message": "رسالة جديدة", "1 at a time": "رسالة واحدة كل مرة", Recipient: "المستلم", "Enter a number manually": "أدخل رقمًا يدويًا", "Phone number": "رقم الهاتف", Message: "الرسالة", "Write an expected transactional message…": "اكتب رسالة معاملات متوقعة…", "Single SMS segment": "مقطع SMS واحد", "Send time": "وقت الإرسال", "I confirm this recipient expects this message.": "أؤكد أن هذا المستلم يتوقع هذه الرسالة.", "Add to queue": "إضافة إلى الطابور",
  "ANDROID ROUTE": "مسار أندرويد", "Your sending phone": "هاتف الإرسال", "Not paired": "غير مقترن", "Waiting for QR pairing": "بانتظار الاقتران عبر QR", Controller: "وحدة التحكم", "Last heartbeat": "آخر اتصال", "Carrier sending": "إرسال عبر الشبكة", Locked: "مقفل", Enabled: "مفعّل", "Connect with QR": "الربط عبر QR",
  "The phone is connected, but live SMS is locked. Open Device and enable it only when you are ready to send.": "الهاتف متصل، لكن إرسال SMS الحقيقي مقفل. افتح الجهاز وفعّله فقط عندما تكون مستعدًا للإرسال.",
  "LIVE QUEUE": "الطابور المباشر", "Recent activity": "النشاط الأخير", "Open message history": "فتح سجل الرسائل", RECIPIENTS: "المستلمون", "Contact book": "دليل جهات الاتصال", "Import or add contacts": "استيراد أو إضافة جهات اتصال", "DELIVERY GUARD": "حماية التسليم", "Safety stays on": "الحماية تبقى مفعّلة", "Opt-outs checked before every claim": "تُفحص قائمة الإيقاف قبل كل رسالة", "Phone receives one message only": "يستلم الهاتف رسالة واحدة فقط", "Six-second dispatch fence": "فاصل أمان ست ثوانٍ", "No blind retry after an uncertain send": "لا إعادة عمياء بعد إرسال غير مؤكد", "Designed for expected transactional messages on a trusted private network.": "مصمم لرسائل المعاملات المتوقعة على شبكة خاصة موثوقة.",
  "QUEUE & HISTORY": "الطابور والسجل", "All recent messages": "كل الرسائل الأخيرة", "Queued messages can be cancelled before the phone begins.": "يمكن إلغاء الرسائل قبل أن يبدأ الهاتف بإرسالها.", Status: "الحالة", Scheduled: "موعد الإرسال", Created: "تاريخ الإنشاء", "No messages yet": "لا توجد رسائل بعد", "Use Quick send on Overview to add the first one.": "استخدم الإرسال السريع لإضافة أول رسالة.", Cancel: "إلغاء",
  "ONE PERSON": "شخص واحد", "Add contact": "إضافة جهة اتصال", Name: "الاسم", Phone: "الهاتف", "Consent reference": "مرجع الموافقة", "Contract, ticket, booking…": "عقد أو تذكرة أو حجز…", "This person expects transactional messages.": "هذا الشخص يتوقع رسائل معاملات.", "Save contact": "حفظ جهة الاتصال", "Import a contact list": "استيراد قائمة جهات اتصال", "Choose a contact file": "اختر ملف جهات اتصال", "Up to 15 MB. Nothing is sent until you confirm.": "حتى 15 MB. لن يُرسل شيء قبل تأكيدك.", "No file selected.": "لم يتم اختيار ملف.", "Shared consent reference": "مرجع الموافقة المشترك", "Source or agreement for this list": "مصدر أو اتفاق هذه القائمة", "Every imported person expects these messages.": "كل شخص مستورد يتوقع هذه الرسائل.", "Import contacts": "استيراد جهات الاتصال", "SAVED LOCALLY": "محفوظة محليًا", "All contacts": "كل جهات الاتصال", "Search by name or number": "ابحث بالاسم أو الرقم", State: "الحالة", "No contacts saved": "لا توجد جهات اتصال محفوظة", "Add one or import your reference CSV file.": "أضف جهة اتصال أو استورد ملف CSV.", Restore: "استعادة", Stop: "إيقاف",
  "Compatible with": "متوافق مع", "Multiple numbers separated by semicolons become separate contacts.": "تتحول الأرقام المتعددة المفصولة بفاصلة منقوطة إلى جهات اتصال مستقلة.",
  "CONTROLLED BATCH": "دفعة مضبوطة", "Create campaign": "إنشاء حملة", "One-by-one dispatch": "إرسال واحدة تلو الأخرى", "Campaign name": "اسم الحملة", "Appointment reminders": "تذكيرات المواعيد", "Write one message for the selected contacts…": "اكتب رسالة واحدة لجهات الاتصال المحددة…", "Start time": "وقت البدء", "Expected recipients": "المستلمون المتوقعون", "Save contacts first.": "احفظ جهات الاتصال أولًا.", "Every selected recipient expects this transactional message.": "كل مستلم محدد يتوقع رسالة المعاملات هذه.", "Add campaign to queue": "إضافة الحملة إلى الطابور", "HOW IT MOVES": "كيف تتحرك", "Computer holds the campaign": "الكمبيوتر يحتفظ بالحملة", Validate: "تحقق", "Opt-outs and consent references are checked.": "تُفحص قوائم الإيقاف ومراجع الموافقة.", Queue: "الطابور", "Every recipient gets an individual local job.": "يحصل كل مستلم على مهمة محلية مستقلة.", Claim: "الاستلام", "The phone receives only the next eligible SMS.": "يستلم الهاتف رسالة SMS التالية المؤهلة فقط.", "No spam automation": "لا أتمتة للرسائل المزعجة", "Nabda does not remove carrier rules or recipient consent requirements. Stop requests are enforced before dispatch.": "لا تلغي نبضة قواعد شركة الاتصالات أو متطلبات موافقة المستلم. تُنفذ طلبات الإيقاف قبل الإرسال.",
  "NEW MESSAGE BATCH": "دفعة رسائل جديدة", "Choose who receives it": "اختر من يستلم الرسالة", "Controlled queue": "طابور مضبوط", "Batch name": "اسم الدفعة", "Select all": "تحديد الكل", Clear: "مسح التحديد", "Names beginning with": "الأسماء التي تبدأ بـ", "All letters": "كل الحروف", "0 selected": "٠ محدد", "Delivery timing": "توقيت الإرسال", "Send immediately": "إرسال فوري", "Use a time window": "استخدام فترة زمنية", From: "من", To: "إلى", "Messages per hour": "الرسائل في الساعة", "Messages enter the queue now, one at a time.": "تدخل الرسائل إلى الطابور الآن، واحدة كل مرة.", "Add messages to queue": "إضافة الرسائل إلى الطابور", "Computer holds the batch": "الكمبيوتر يحتفظ بالدفعة", Schedule: "جدولة", "Each recipient receives a separate time slot.": "يحصل كل مستلم على وقت إرسال مستقل.",
  "ONE-TIME PAIRING": "اقتران لمرة واحدة", "Connect your Android phone": "اربط هاتف أندرويد", Ready: "جاهز", "Phone name": "اسم الهاتف", "Company Android": "هاتف الشركة", "Create pairing QR": "إنشاء رمز QR للاقتران", "Scan this with Nabda Agent": "امسح الرمز بتطبيق Nabda Agent", "CURRENT PHONE": "الهاتف الحالي", "No phone paired": "لا يوجد هاتف مقترن", Connection: "الاتصال", "Controller address": "عنوان وحدة التحكم", "CARRIER SAFETY LOCK": "قفل أمان الشبكة", "Live SMS": "رسائل SMS حقيقية", "Allow Android carrier dispatch": "السماح بالإرسال من شريحة أندرويد", "Type ENABLE_LIVE_SMS": "اكتب ENABLE_LIVE_SMS", "Apply safety state": "تطبيق حالة الأمان",
  "Keep Windows and Android on the same trusted Wi-Fi. Create a code, open Nabda Agent, and tap": "أبقِ ويندوز وأندرويد على شبكة Wi-Fi موثوقة واحدة. أنشئ رمزًا، وافتح Nabda Agent، ثم اضغط", "Scan controller QR": "مسح QR لوحدة التحكم", "The QR works once. It does not contain the permanent device key.": "يعمل رمز QR مرة واحدة ولا يحتوي مفتاح الجهاز الدائم.", "Keep this locked during testing. Enabling it still requires confirmation and SMS permission on Android.": "اتركه مقفلًا أثناء الاختبار. يتطلب تفعيله تأكيدًا وصلاحية SMS على أندرويد.", "One-time Nabda phone pairing QR code": "رمز QR لاقتران هاتف نبضة لمرة واحدة",
  Never: "أبدًا", "Just now": "الآن", Connected: "متصل", Paired: "مقترن", "Controller running": "وحدة التحكم تعمل", "Android phone is connected": "هاتف أندرويد متصل", "Connected and checking the queue": "متصل ويفحص الطابور", "Paired, waiting for the agent": "مقترن وبانتظار التطبيق", "Connected to the local queue": "متصل بالطابور المحلي", "Paired · waiting for heartbeat": "مقترن · بانتظار الاتصال", "No contacts yet": "لا توجد جهات اتصال بعد", "Import your CSV to begin.": "استورد ملف CSV للبدء.", "Your queue is quiet": "الطابور فارغ", "New activity will appear here.": "سيظهر النشاط الجديد هنا.", active: "نشط", "opted-out": "متوقف", stopped: "متوقف", queued: "في الطابور", sent: "مُرسلة", delivered: "تم التسليم", failed: "فشلت", cancelled: "ملغاة", expired: "منتهية", processing: "قيد المعالجة"
};
let language = localStorage.getItem("nabda-controller-language") === "ar" ? "ar" : "en";
const originalText = new WeakMap();
const originalAttributes = new WeakMap();
let state = null;
let pendingContactImport = [];
let pairingTimer = null;
let selectedCampaignContacts = new Set();

function t(value) { return language === "ar" ? (translations[value] || value) : value; }
function number(value) { return new Intl.NumberFormat(language === "ar" ? "ar-LY" : "en-US").format(value); }
function localizeDom(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) continue;
    const english = originalText.get(node) ?? node.nodeValue.trim();
    if (!english) continue;
    originalText.set(node, english);
    const leading = node.nodeValue.match(/^\s*/)?.[0] || "";
    const trailing = node.nodeValue.match(/\s*$/)?.[0] || "";
    node.nodeValue = `${leading}${t(english)}${trailing}`;
  }
  root.querySelectorAll?.("[placeholder],[aria-label],[alt]").forEach((element) => {
    let values = originalAttributes.get(element);
    if (!values) {
      values = {};
      for (const name of ["placeholder", "aria-label", "alt"]) if (element.hasAttribute(name)) values[name] = element.getAttribute(name);
      originalAttributes.set(element, values);
    }
    for (const [name, english] of Object.entries(values)) element.setAttribute(name, t(english));
  });
}
function applyLanguage() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = language === "ar" ? "وحدة تحكم نبضة" : "Nabda Controller";
  $$('[data-language]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.language === language)));
  if (state) render();
  else localizeDom();
}

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
  if (!value) return t("Never");
  return new Intl.DateTimeFormat(language === "ar" ? "ar-LY" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function relativeDate(value) {
  if (!value) return t("Never");
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return t("Just now");
  const formatter = new Intl.RelativeTimeFormat(language === "ar" ? "ar-LY" : "en", { numeric: "always", style: "short" });
  if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
  return date(value);
}

function status(value) {
  const safeClass = String(value).replace(/[^a-z-]/g, "");
  return `<span class="status ${safeClass}">${escapeHtml(t(value))}</span>`;
}

function showView(name) {
  if (!pageTitles[name]) return;
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#page-title").textContent = t(pageTitles[name]);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function contactRows(contacts) {
  return contacts.map((contact) => `<tr>
    <td>${escapeHtml(contact.name)}</td>
    <td>${escapeHtml(contact.phone)}</td>
    <td>${escapeHtml(contact.consent_reference || "—")}</td>
    <td>${contact.opted_out ? status("opted-out") : status("active")}</td>
    <td><button class="table-action" data-optout="${contact.id}" data-value="${!contact.opted_out}">${t(contact.opted_out ? "Restore" : "Stop")}</button></td>
  </tr>`).join("");
}

function renderContactsTable() {
  if (!state) return;
  const query = $("#contact-search").value.trim().toLowerCase();
  const contacts = state.contacts.filter((contact) => !query || `${contact.name} ${contact.phone}`.toLowerCase().includes(query));
  $("#contacts-table").innerHTML = contactRows(contacts);
  $("#contacts-empty").hidden = state.contacts.length > 0;
}

function contactLetter(name) {
  const value = String(name || "").trim().charAt(0).toLocaleUpperCase(language === "ar" ? "ar" : "en");
  return value && /[\p{L}\p{N}]/u.test(value) ? value : "#";
}

function updateScheduleEstimate() {
  const count = selectedCampaignContacts.size;
  const mode = $('#campaign-form input[name="schedule_mode"]:checked')?.value || "now";
  const window = $("#schedule-window");
  window.hidden = mode !== "window";
  window.querySelectorAll("input").forEach((input) => { input.required = mode === "window"; });
  if (mode === "now") {
    $("#schedule-estimate").textContent = language === "ar"
      ? `ستدخل ${number(count)} رسالة إلى الطابور الآن، واحدة كل مرة.`
      : `${number(count)} messages will enter the queue now, one at a time.`;
    return;
  }
  const rate = Math.max(1, Math.min(600, Number($('#campaign-form [name="messages_per_hour"]').value) || 60));
  const minutes = count < 2 ? 0 : Math.ceil((count - 1) * 60 / rate);
  $("#schedule-estimate").textContent = language === "ar"
    ? `${number(count)} رسالة بمعدل ${number(rate)} في الساعة تحتاج نحو ${number(minutes)} دقيقة.`
    : `${number(count)} messages at ${number(rate)} per hour need about ${number(minutes)} minutes.`;
}

function renderRecipientPicker() {
  if (!state) return;
  const eligible = state.contacts.filter((contact) => !contact.opted_out)
    .sort((left, right) => left.name.localeCompare(right.name, language === "ar" ? "ar" : "en", { sensitivity: "base" }));
  const validIds = new Set(eligible.map((contact) => contact.id));
  selectedCampaignContacts = new Set([...selectedCampaignContacts].filter((id) => validIds.has(id)));
  const filter = $("#contact-letter-filter");
  const previousLetter = filter.value || "all";
  const letters = [...new Set(eligible.map((contact) => contactLetter(contact.name)))].sort((a, b) => a.localeCompare(b, language === "ar" ? "ar" : "en"));
  filter.innerHTML = `<option value="all">${language === "ar" ? "كل الحروف" : "All letters"}</option>`
    + letters.map((letter) => `<option value="${escapeHtml(letter)}">${escapeHtml(letter)}</option>`).join("");
  filter.value = [...filter.options].some((option) => option.value === previousLetter) ? previousLetter : "all";
  const visible = eligible.filter((contact) => filter.value === "all" || contactLetter(contact.name) === filter.value);
  $("#campaign-contacts").innerHTML = visible.map((contact) => `<label class="contact-option"><input type="checkbox" name="contact_ids" value="${contact.id}" ${selectedCampaignContacts.has(contact.id) ? "checked" : ""} /><span>${escapeHtml(contact.name)}<small>${escapeHtml(contact.phone)}</small></span></label>`).join("") || `<p class="empty-copy">${t("Save contacts first.")}</p>`;
  $("#selected-recipient-count").textContent = language === "ar" ? `${number(selectedCampaignContacts.size)} محدد` : `${number(selectedCampaignContacts.size)} selected`;
  updateScheduleEstimate();
}

function render() {
  const { system, device, counts, contacts, messages } = state;
  $("#system-label").textContent = t("Controller running");
  $("#status-detail").textContent = t(device?.last_seen_at ? "Android phone is connected" : "Local data stays on this computer");
  $("#service-status .pulse").className = `pulse ${device?.last_seen_at ? "" : "checking"}`.trim();
  $("#lan-url").textContent = system.lan_url;
  $("#device-url").textContent = system.lan_url;
  $("#live-state").textContent = t(system.live_enabled ? "Enabled" : "Locked");
  $("#delivery-note").hidden = !device?.last_seen_at || system.live_enabled;
  $("#delivery-note").textContent = t("The phone is connected, but live SMS is locked. Open Device and enable it only when you are ready to send.");
  $("#live-checkbox").checked = system.live_enabled;
  $("#used-count").textContent = number(system.monthly_used);
  $("#usage-left").textContent = number(Math.max(0, system.monthly_limit - system.monthly_used));
  $("#usage-meter").style.width = `${Math.min(100, system.monthly_used / system.monthly_limit * 100)}%`;
  $("#queued-count").textContent = number(counts.queued);
  $("#sent-count").textContent = number(counts.sent);
  $("#failed-count").textContent = number(counts.failed);
  $("#contacts-count").textContent = number(counts.contacts);
  $("#contacts-list-count").textContent = number(counts.contacts);
  $("#last-seen").textContent = relativeDate(device?.last_seen_at);
  $("#device-last-seen").textContent = relativeDate(device?.last_seen_at);
  $("#device-name-display").textContent = device?.name || t("No phone paired");
  $("#device-status-detail").textContent = t(device?.last_seen_at ? "Connected and checking the queue" : device ? "Paired, waiting for the agent" : "Waiting for QR pairing");
  $("#phone-visual-status").textContent = t(device?.last_seen_at ? "Connected to the local queue" : device ? "Paired · waiting for heartbeat" : "Waiting for QR pairing");
  $("#device-chip").textContent = t(device?.last_seen_at ? "Connected" : device ? "Paired" : "Not paired");
  $("#device-chip").classList.toggle("connected", Boolean(device?.last_seen_at));
  $("#device-pulse").className = `pulse ${device?.last_seen_at ? "" : "offline"}`.trim();

  const options = contacts.filter((contact) => !contact.opted_out).map((contact) => `<option value="${contact.id}" data-phone="${escapeHtml(contact.phone)}">${escapeHtml(contact.name)} · ${escapeHtml(contact.phone)}</option>`).join("");
  const selectedContact = $("#message-contact").value;
  $("#message-contact").innerHTML = `<option value="">${t("Enter a number manually")}</option>` + options;
  if ([...$("#message-contact").options].some((option) => option.value === selectedContact)) $("#message-contact").value = selectedContact;

  $("#quick-contacts").innerHTML = contacts.slice(0, 5).map((contact) => `<div class="quick-contact"><span class="contact-avatar">${escapeHtml(contact.name.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(contact.name)}</strong><small>${escapeHtml(contact.phone)}</small></span>${contact.opted_out ? status("stopped") : ""}</div>`).join("") || `<div class="empty-state"><strong>${t("No contacts yet")}</strong><span>${t("Import your CSV to begin.")}</span></div>`;

  $("#dashboard-activity").innerHTML = messages.slice(0, 5).map((message) => `<div class="activity-row"><span class="activity-icon"><i data-lucide="${["sent", "delivered"].includes(message.status) ? "check" : message.status === "failed" ? "triangle-alert" : "clock-3"}"></i></span><span><strong>${escapeHtml(message.to)}</strong><small>${escapeHtml(message.content.length > 42 ? `${message.content.slice(0, 39)}…` : message.content)}</small></span><time>${relativeDate(message.created_at)}</time></div>`).join("") || `<div class="empty-state"><strong>${t("Your queue is quiet")}</strong><span>${t("New activity will appear here.")}</span></div>`;

  $("#messages-table").innerHTML = messages.map((message) => `<tr><td>${escapeHtml(message.to)}</td><td>${escapeHtml(message.content.length > 80 ? `${message.content.slice(0, 77)}…` : message.content)}</td><td>${status(message.status)}</td><td>${date(message.scheduled_at)}</td><td>${date(message.created_at)}</td><td>${message.status === "queued" ? `<button class="table-action" data-cancel="${message.id}">${t("Cancel")}</button>` : ""}</td></tr>`).join("");
  $("#messages-empty").hidden = messages.length > 0;
  renderContactsTable();

  renderRecipientPicker();
  localizeDom();
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
    $("#pairing-expiry").textContent = seconds
      ? (language === "ar" ? `ينتهي خلال ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`)
      : (language === "ar" ? "انتهت الصلاحية — أنشئ رمزًا جديدًا" : "Expired — create a new code");
    $("#pairing-state").textContent = seconds ? (language === "ar" ? "بانتظار المسح" : "Waiting for scan") : (language === "ar" ? "منتهي" : "Expired");
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
    toast(language === "ar" ? "أُضيفت الرسالة إلى الطابور المحلي." : "Message added to the local queue.");
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#contact-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await request("/control-api/contacts", { method: "POST", body: JSON.stringify({ name: data.get("name"), phone: data.get("phone"), consent_reference: data.get("consent_reference"), consent_confirmed: data.get("consent") === "on" }) });
    event.currentTarget.reset();
    toast(language === "ar" ? "حُفظت جهة الاتصال محليًا." : "Contact saved locally.");
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#contact-import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  pendingContactImport = [];
  $("#contact-import-button").disabled = true;
  if (!file) return $("#contact-import-result").textContent = t("No file selected.");
  if (file.size > CONTACT_FILE_MAX_BYTES) return $("#contact-import-result").textContent = language === "ar" ? "حجم الملف أكبر من 15 MB." : "The file is larger than 15 MB.";
  try {
    pendingContactImport = contactsFromFile(await file.text(), file.name);
    $("#contact-import-result").textContent = pendingContactImport.length
      ? (language === "ar" ? `جاهز: وُجد ${number(pendingContactImport.length)} اسمًا ورقمًا فريدًا.` : `Ready: found ${number(pendingContactImport.length)} unique names and numbers.`)
      : (language === "ar" ? "لم يتم العثور على أسماء وأرقام هاتف قابلة للقراءة." : "No readable names and phone numbers were found.");
    $("#contact-import-button").disabled = pendingContactImport.length < 1;
  } catch { $("#contact-import-result").textContent = language === "ar" ? "تعذرت قراءة الملف." : "The file could not be read."; }
});

$("#contact-import-button").addEventListener("click", async () => {
  const reference = $("#contact-import-reference").value.trim();
  if (!reference) return toast(language === "ar" ? "أضف مصدر الموافقة لقائمة جهات الاتصال." : "Add the consent source for this contact list.");
  if (!$("#contact-import-consent").checked) return toast(language === "ar" ? "أكد أن كل شخص يتوقع هذه الرسائل." : "Confirm that every person expects these messages.");
  if (!pendingContactImport.length) return toast(language === "ar" ? "اختر ملف جهات اتصال أولًا." : "Choose a contact file first.");
  const button = $("#contact-import-button");
  button.disabled = true;
  const totals = { imported: 0, duplicates: 0, invalid: 0 };
  try {
    for (let start = 0; start < pendingContactImport.length; start += CONTACT_IMPORT_BATCH_SIZE) {
      const batch = pendingContactImport.slice(start, start + CONTACT_IMPORT_BATCH_SIZE);
      $("#contact-import-result").textContent = language === "ar"
        ? `جارٍ استيراد ${number(Math.min(start + batch.length, pendingContactImport.length))} من ${number(pendingContactImport.length)}…`
        : `Importing ${number(Math.min(start + batch.length, pendingContactImport.length))} of ${number(pendingContactImport.length)}…`;
      const result = await request("/control-api/contacts/import", { method: "POST", body: JSON.stringify({ contacts: batch, consent_reference: reference, consent_confirmed: true }) });
      totals.imported += result.imported;
      totals.duplicates += result.duplicates;
      totals.invalid += result.invalid;
    }
    $("#contact-import-result").textContent = language === "ar"
      ? `اكتمل: أُضيف ${number(totals.imported)}، مكرر ${number(totals.duplicates)}، غير صالح ${number(totals.invalid)}.`
      : `Done: ${number(totals.imported)} added, ${number(totals.duplicates)} duplicates, ${number(totals.invalid)} invalid.`;
    $("#contact-import-file").value = "";
    pendingContactImport = [];
    toast(language === "ar" ? `تم استيراد ${number(totals.imported)} جهة اتصال.` : `${number(totals.imported)} contacts imported.`);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = pendingContactImport.length < 1;
  }
});

$("#contact-search").addEventListener("input", renderContactsTable);

$("#campaign-contacts").addEventListener("change", (event) => {
  if (!event.target.matches('input[name="contact_ids"]')) return;
  if (event.target.checked) selectedCampaignContacts.add(event.target.value);
  else selectedCampaignContacts.delete(event.target.value);
  renderRecipientPicker();
});

$("#contact-letter-filter").addEventListener("change", renderRecipientPicker);
$("#campaign-form").addEventListener("change", (event) => {
  if (event.target.matches('[name="schedule_mode"],[name="messages_per_hour"]')) updateScheduleEstimate();
});
$("#campaign-form").addEventListener("input", (event) => {
  if (event.target.matches('[name="messages_per_hour"]')) updateScheduleEstimate();
});

$("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    if (!selectedCampaignContacts.size) throw new Error(language === "ar" ? "اختر مستلمًا واحدًا على الأقل." : "Select at least one recipient.");
    const windowMode = data.get("schedule_mode") === "window";
    const result = await request("/control-api/campaigns", { method: "POST", body: JSON.stringify({
      name: data.get("name"), content: data.get("content"), contact_ids: [...selectedCampaignContacts],
      send_at: windowMode ? data.get("send_at") || undefined : undefined,
      send_until: windowMode ? data.get("send_until") || undefined : undefined,
      messages_per_hour: windowMode ? Number(data.get("messages_per_hour")) : 600,
      consent_confirmed: data.get("consent") === "on",
    }) });
    event.currentTarget.reset();
    selectedCampaignContacts.clear();
    $("#contact-letter-filter").value = "all";
    renderRecipientPicker();
    toast(language === "ar" ? `أُضيفت الحملة: ${number(result.queued)} رسالة، وتوقفت ${number(result.skippedOptOut)}.` : `Campaign queued: ${number(result.queued)} messages, ${number(result.skippedOptOut)} stopped.`);
    await refresh();
  } catch (error) { toast(error.message); }
});

$("#create-pairing").addEventListener("click", async () => {
  try {
    const pairing = await request("/control-api/pairing", { method: "POST", body: JSON.stringify({ name: $("#device-name").value }) });
    if (typeof window.qrcode !== "function") throw new Error(language === "ar" ? "مولّد QR غير متاح." : "QR generator is unavailable.");
    const qr = window.qrcode(0, "M");
    qr.addData(pairing.pairing_uri);
    qr.make();
    $("#pairing-qr").src = qr.createDataURL(7, 4);
    $("#pairing-panel").classList.remove("hidden");
    startPairingCountdown(pairing.expires_at);
    toast(language === "ar" ? "تم إنشاء رمز QR لمرة واحدة. امسحه بتطبيق Nabda Agent." : "One-time QR created. Scan it with Nabda Agent.");
  } catch (error) { toast(error.message); }
});

$("#save-live").addEventListener("click", async () => {
  try {
    const enabled = $("#live-checkbox").checked;
    await request("/control-api/live", { method: "POST", body: JSON.stringify({ enabled, confirmation: $("#live-confirmation").value }) });
    $("#live-confirmation").value = "";
    toast(language === "ar" ? (enabled ? "تم تفعيل الإرسال عبر الشريحة." : "تم قفل الإرسال عبر الشريحة.") : (enabled ? "Carrier sending enabled." : "Carrier sending locked."));
    await refresh();
  } catch (error) { toast(error.message); }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  if (target.dataset.language) {
    language = target.dataset.language === "ar" ? "ar" : "en";
    localStorage.setItem("nabda-controller-language", language);
    applyLanguage();
    return;
  }
  if (target.dataset.recipientSelect) {
    if (target.dataset.recipientSelect === "all" && state) {
      selectedCampaignContacts = new Set(state.contacts.filter((contact) => !contact.opted_out).map((contact) => contact.id));
    } else {
      selectedCampaignContacts.clear();
    }
    renderRecipientPicker();
    return;
  }
  if (target.dataset.view) return showView(target.dataset.view);
  if (target.dataset.viewTarget) return showView(target.dataset.viewTarget);
  try {
    if (target.matches("[data-refresh]")) await refresh();
    if (target.dataset.cancel) {
      await request(`/control-api/messages/${target.dataset.cancel}/cancel`, { method: "POST", body: "{}" });
      toast(language === "ar" ? "تم إلغاء الرسالة الموجودة في الطابور." : "Queued message cancelled.");
      await refresh();
    }
    if (target.dataset.optout) {
      await request(`/control-api/contacts/${target.dataset.optout}/opt-out`, { method: "POST", body: JSON.stringify({ opted_out: target.dataset.value === "true" }) });
      toast(language === "ar" ? "تم تحديث حالة المستلم." : "Recipient state updated.");
      await refresh();
    }
  } catch (error) { toast(error.message); }
});

renderIcons();
applyLanguage();
refresh();
setInterval(refresh, 5000);

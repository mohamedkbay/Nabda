export const CONTACT_FILE_MAX_BYTES = 15_000_000;
export const CONTACT_IMPORT_BATCH_SIZE = 500;

function cleanText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\\n/gi, " ")
    .replace(/\\([,;\\])/g, "$1")
    .trim();
}

function decodeQuotedPrintable(value) {
  const bytes = [];
  const encoder = new TextEncoder();
  const source = String(value || "").replace(/=\r?\n/g, "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "=" && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...encoder.encode(source[index]));
    }
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

function vCardValue(meta, value) {
  return cleanText(/ENCODING=QUOTED-PRINTABLE/i.test(meta) ? decodeQuotedPrintable(value) : value);
}

function parseVcf(text) {
  const unfolded = String(text || "")
    .replace(/=\r?\n/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "");
  const contacts = [];
  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const card = block.split(/END:VCARD/i)[0] || "";
    let name = "";
    let structuredName = "";
    const phones = [];
    for (const line of card.split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const meta = line.slice(0, colon);
      const property = meta.split(";", 1)[0].toUpperCase();
      const value = vCardValue(meta, line.slice(colon + 1));
      if (property === "FN" && !name) name = value;
      if (property === "N" && !structuredName) {
        structuredName = value.split(";").map(cleanText).filter(Boolean).slice(0, 2).reverse().join(" ");
      }
      if (property === "TEL") {
        const phone = value.replace(/^tel:/i, "").split(";", 1)[0].trim();
        if (phone) phones.push(phone);
      }
    }
    const contactName = name || structuredName || "Unnamed contact";
    [...new Set(phones)].forEach((phone) => contacts.push({ name: contactName, phone }));
  }
  return contacts;
}

function delimiterCount(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(text) {
  const line = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).find((item) => item.trim()) || "";
  const best = ["\t", ",", ";", "،"]
    .map((delimiter) => ({ delimiter, count: delimiterCount(line, delimiter) }))
    .sort((left, right) => right.count - left.count)[0];
  return best?.count ? best.delimiter : null;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (character === "\n") {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") cell += character;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizedHeader(value) {
  return cleanText(value).toLowerCase().replace(/[\s_()-]/g, "");
}

function parseRows(text) {
  const delimiter = detectDelimiter(text);
  const rows = delimiter
    ? parseDelimited(text, delimiter)
    : String(text || "").split(/\r?\n/).map((line) => [line.trim()]).filter((row) => row[0]);
  if (!rows.length) return [];
  const header = rows[0].map(normalizedHeader);
  const nameHeaders = new Set(["name", "fullname", "contactname", "الاسم", "اسم"]);
  const phoneHeaders = new Set(["phone", "phones", "phonenumber", "phonenumbers", "mobile", "mobilenumber", "tel", "telephone", "الهاتف", "الرقم", "رقمالهاتف", "رقم"]);
  const nameIndex = header.findIndex((value) => nameHeaders.has(value));
  const phoneIndex = header.findIndex((value) => phoneHeaders.has(value));
  const hasHeader = nameIndex >= 0 && phoneIndex >= 0;
  const contacts = [];
  for (const sourceParts of hasHeader ? rows.slice(1) : rows) {
    let parts = sourceParts;
    let rowNameIndex = hasHeader ? nameIndex : 0;
    let rowPhoneIndex = hasHeader ? phoneIndex : parts.findLastIndex((value) => /(?:\+|00|0)?\d[\d\s()-]{6,}/.test(value));
    if (parts.length === 1 && !hasHeader) {
      const match = parts[0].match(/^(.*?)[،,;\t ]+((?:\+|00|0)?\d[\d\s()-]{6,})$/);
      if (!match) continue;
      parts = [match[1], match[2]];
      rowNameIndex = 0;
      rowPhoneIndex = 1;
    }
    if (rowPhoneIndex < 0) continue;
    const name = cleanText(parts[rowNameIndex]) || "Unnamed contact";
    const phones = cleanText(parts[rowPhoneIndex]).split(/[;|]/).map((value) => value.trim()).filter(Boolean);
    phones.forEach((phone) => contacts.push({ name, phone }));
  }
  return contacts;
}

function uniqueContacts(contacts) {
  const seen = new Set();
  return contacts.filter((contact) => {
    const key = String(contact.phone || "").replace(/[\s()-]/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function contactsFromFile(text, fileName = "") {
  const isVcf = fileName.toLowerCase().endsWith(".vcf") || /BEGIN:VCARD/i.test(text);
  return uniqueContacts(isVcf ? parseVcf(text) : parseRows(text));
}

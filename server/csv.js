// Minimal RFC-4180 CSV parser/serializer (handles quotes, embedded commas/newlines).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  rows.push(row);

  // drop trailing blank line
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

export function csvToRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { columns: [], records: [] };
  const columns = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    columns.forEach((c, idx) => {
      o[c] = r[idx] ?? '';
    });
    return o;
  });
  return { columns, records };
}

export function toCsv(columns, records) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of records) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n');
}

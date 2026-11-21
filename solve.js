// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly csv-reader 1.0.0's answer {columns, rows, errors} for every
// {text, header}, but reads the text with regex/indexOf scans and slices
// instead of one character at a time:
//
//   - A U+FEFF at the very start is dropped.
//   - A record ends at LF or CRLF; a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (stray_cr).
//   - A field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote, each CRLF or lone CR inside it is
//     read as LF); what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal character. Fields stay
//     strings, never trimmed or converted.
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's
//     width. Each error is {code, line, row}, in the order met; line is the
//     1-based line its record starts on (every LF, CRLF and lone CR inside
//     quotes counted), row its record's index in rows, null for the header.
//
// Speed: most records are clean lines, so each record is taken as one slice
// and split(',') in C++ instead of being walked character by character. A
// line holding a quote or a stray CR takes the field-by-field path, which
// scans with one sticky regex per field and slices fields instead of building
// them a character at a time; the plain unquoted field is scanned inline in
// the record loop, with no call and no result object per field. Pure: no
// clock, no randomness, no locale, nothing kept from one call to the next.
//
// SPDX-License-Identifier: MIT

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next terminator of an unquoted field: a comma, LF or CR. One regex scan beats three indexOf calls.
  const TERMINATOR = /[,\n\r]/g;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field, how it ended and how many characters were kept (`added` counts only the
  // characters this read kept, so a quote_junk check on the junk after a closing quote sees just the junk).
  // Used only for the text after a closing quote and after an unterminated quote: the plain unquoted field is
  // scanned inline in the record loop below.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      TERMINATOR.lastIndex = pos;
      const m = TERMINATOR.exec(text);
      if (m === null) {
        if (pos < n) { value = value ? value + text.slice(pos, n) : text.slice(pos, n); added += n - pos; pos = n; }
        return { value, ended: END, added };
      }
      const at = m.index;
      if (at > pos) { value = value ? value + text.slice(pos, at) : text.slice(pos, at); added += at - pos; }
      const c = text.charCodeAt(at);
      if (c === 44) {
        pos = at + 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos = at + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: a line break when followed by LF, else a stray CR, dropped.
      if (text.charCodeAt(at + 1) === 10) {
        pos = at + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = at + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let cur = pos + 1;
    let parts = null; // segments kept when a doubled quote was met; null keeps the plain slice
    let closedAt = -1;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(cur, q), '"');
        cur = q + 2;
        continue;
      }
      closedAt = q;
      break;
    }
    let value;
    if (parts === null) {
      value = text.slice(pos + 1, closedAt);
    } else {
      parts.push(text.slice(cur, closedAt));
      value = parts.join('');
    }
    // Each CRLF or lone CR inside quotes is one LF, and each counts as one line.
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      const breaks = value.match(/\r\n|\r|\n/g);
      if (breaks !== null) line += breaks.length;
      if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
    }
    pos = closedAt + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Finishes a record read into `fields`: the header, or a row at the first record's width.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < n) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: one clean line is one record. A line holds no quote and no CR other than a trailing CRLF one,
    // so its fields are exactly its comma split.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      let segEnd = nl;
      if (segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
      if (segEnd > pos) {
        const seg = text.slice(pos, segEnd);
        if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
          line += 1;
          pos = nl + 1;
          finishRecord(seg.split(','));
          continue;
        }
      } else {
        // A line of only "\r" before the LF: a blank CRLF line, no record.
        line += 1;
        pos = nl + 1;
        continue;
      }
    }

    // Slow path: a line holding a quote or a stray CR, or the last line with no line break after it.
    const fields = [];
    let ended;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const field = readQuoted();
        fields.push(field.value);
        ended = field.ended;
      } else {
        // Plain unquoted field, scanned inline: no call and no result object per field.
        lastQuoted = false;
        let value = '';
        for (;;) {
          TERMINATOR.lastIndex = pos;
          const m = TERMINATOR.exec(text);
          if (m === null) {
            if (pos < n) value = value ? value + text.slice(pos, n) : text.slice(pos, n);
            pos = n;
            ended = END;
            break;
          }
          const at = m.index;
          if (at > pos) value = value ? value + text.slice(pos, at) : text.slice(pos, at);
          const c = text.charCodeAt(at);
          if (c === 44) {
            pos = at + 1;
            ended = COMMA;
            break;
          }
          if (c === 10) {
            pos = at + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (text.charCodeAt(at + 1) === 10) {
            pos = at + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = at + 1;
        }
        fields.push(value);
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

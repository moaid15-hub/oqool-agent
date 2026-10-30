// Quarantined 2026-10-30: the line-level reading-order fix of 0.6.0, replaced in 0.6.2 by rebuilding lines from the
// positioned pieces of text (docs.mjs lineText). Not used; kept until confirmed unused · محجور: غير مستعمل
// PDFs often keep Arabic in display order with presentation-form letters: bring each mostly right-to-left line back to
// reading order (letters to their normal form; Latin words and numbers inside it keep their own order)
// كثير من ملفات PDF تحفظ العربي بترتيب العرض وبأشكال الحروف: نعيد السطر لترتيب القراءة
const RTL_CH = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LAT_CH = /[A-Za-z0-9]/g;
const PRESENTATION = /[ﭐ-﷿ﹰ-﻿]/;
export function readingOrder(text) {
  return text.split('\n').map((line) => {
    if (!PRESENTATION.test(line)) return line; // already logical text (no display-form letters)
    const rtl = (line.match(RTL_CH) || []).length;
    const lat = (line.match(LAT_CH) || []).length;
    const norm = line.normalize('NFKC');
    // a left-to-right line: each Arabic stretch (words and the spaces between them) is turned back on its own
    if (rtl <= lat) return norm.replace(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF](?:[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF ]*[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF])?/g, (m) => Array.from(m).reverse().join(''));
    const flipped = Array.from(norm).reverse().join('');
    return flipped.replace(/[A-Za-z0-9][A-Za-z0-9.,:;'"!?%()\/\- _]*[A-Za-z0-9]|[A-Za-z0-9]/g, (m) => Array.from(m).reverse().join(''));
  }).join('\n');
}


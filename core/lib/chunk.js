// Heading-aware, deterministic text chunking for oversized sources.
//
// Greedily packs paragraphs into chunks under a token ceiling (bytes/4), starting
// a fresh chunk at a heading boundary when possible so a chunk stays topically
// coherent. A single paragraph larger than the ceiling is hard-split by lines.
// Deterministic: same text + ceiling -> same chunks, every run.
import { estTokens } from './io.js';

const isHeading = (s) => {
  const first = s.split('\n')[0].trim();
  return (
    /^#{1,6}\s/.test(first) || // markdown heading
    /^§/.test(first) || // section sign
    /^\d+(\.\d+)*\s+\S/.test(first) || // numbered heading "4.2 Foo"
    /^[A-Z][A-Z0-9 ,'\-]{8,}$/.test(first) // ALL-CAPS line
  );
};

const mk = (text) => ({ text, tokens: estTokens(text) });

export function chunkText(text, maxTokens) {
  const maxChars = Math.max(400, maxTokens * 4);
  const paras = text.split(/\n{2,}/).map((p) => p.replace(/\s+$/, '')).filter((p) => p.trim());
  const chunks = [];
  let cur = [];
  let curBytes = 0;

  const flush = () => {
    if (cur.length) chunks.push(mk(cur.join('\n\n')));
    cur = [];
    curBytes = 0;
  };

  for (const para of paras) {
    const bytes = Buffer.byteLength(para, 'utf8');
    if (isHeading(para) && cur.length) flush(); // headings begin a chunk

    if (bytes > maxChars) {
      // Hard-split an over-long paragraph by lines.
      flush();
      let buf = [];
      let bufBytes = 0;
      for (const line of para.split('\n')) {
        const lb = Buffer.byteLength(line, 'utf8') + 1;
        if (bufBytes + lb > maxChars && buf.length) {
          chunks.push(mk(buf.join('\n')));
          buf = [];
          bufBytes = 0;
        }
        buf.push(line);
        bufBytes += lb;
      }
      if (buf.length) chunks.push(mk(buf.join('\n')));
      continue;
    }

    if (curBytes + bytes > maxChars && cur.length) flush();
    cur.push(para);
    curBytes += bytes + 2;
  }
  flush();

  return chunks.map((c, i) => ({ index: i, ...c }));
}

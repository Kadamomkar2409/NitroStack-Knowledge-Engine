import { AppError } from './db.ts';

export interface Passage { text: string; sectionPath: string; page?: number }

export function chunkText(text: string, size = 1600, overlap = 200, page?: number): Passage[] {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) || size < 300 || overlap < 0 || overlap >= size / 2) {
    throw new AppError(503, 'invalid_chunk_settings', 'Set a chunk size of at least 300 and an overlap under half that size.');
  }
  const sections: { title: string; lines: string[] }[] = [{ title: '', lines: [] }];
  const headings: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      headings.length = heading[1].length - 1;
      headings.push(heading[2].trim());
      sections.push({ title: headings.filter(Boolean).join(' / '), lines: [line] });
    } else sections.at(-1)!.lines.push(line);
  }
  return sections.flatMap(({ title, lines }) => {
    const value = lines.join('\n').trim();
    const result: Passage[] = [];
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + size, value.length);
      if (end < value.length) {
        const newline = value.lastIndexOf('\n', end);
        const space = value.lastIndexOf(' ', end);
        const boundary = newline > start + size * 0.65 ? newline : space;
        if (boundary > start + size * 0.65) end = boundary;
      }
      const part = value.slice(start, end).trim();
      if (part) result.push({ text: part, sectionPath: title, ...(page === undefined ? {} : { page }) });
      if (end === value.length) break;
      start = end - overlap;
    }
    return result;
  });
}

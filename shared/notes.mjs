// Change notes are the numbered lines of the description: an ordered list, or paragraphs that start
// with "1." / "2)". Each becomes { n, text } so clouds can be declared against a line number.
export function notesFromAdf(doc) {
  const notes = [];
  const text = (node) => (node.type === 'text' ? node.text : (node.content || []).map(text).join(node.type === 'paragraph' ? '\n' : ''));
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'orderedList') {
      let n = node.attrs?.order || 1;
      for (const item of node.content || []) notes.push({ n: n++, text: text(item).trim() });
      return;
    }
    if (node.type === 'paragraph') {
      for (const line of text(node).split('\n')) {
        const m = line.match(/^\s*(\d{1,2})[.)]\s+(.+)/);
        if (m) notes.push({ n: +m[1], text: m[2].trim() });
      }
      return;
    }
    (node.content || []).forEach(walk);
  };
  walk(doc);
  return notes;
}

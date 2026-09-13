/** Keep programmatic focus restoration from showing keyboard rings after a tap. */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const previous = root.dataset.inputModality;
  root.dataset.inputModality = 'pointer';
  const pointer = () => { root.dataset.inputModality = 'pointer'; };
  const keyboard = (event: KeyboardEvent) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    root.dataset.inputModality = 'keyboard';
  };
  // Capture before button handlers open panels or restore focus to the header.
  doc.addEventListener('pointerdown', pointer, true);
  doc.addEventListener('keydown', keyboard, true);
  return () => {
    doc.removeEventListener('pointerdown', pointer, true);
    doc.removeEventListener('keydown', keyboard, true);
    if (previous === undefined) delete root.dataset.inputModality;
    else root.dataset.inputModality = previous;
  };
}

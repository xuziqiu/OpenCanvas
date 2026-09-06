import type { Editor } from '@tiptap/react';
import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

function directBlock(target: EventTarget | null, root: HTMLElement) {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element.parentElement !== root) element = element.parentElement;
  return element?.parentElement === root ? element : null;
}

function positionAtIndex(editor: Editor, index: number) {
  let position = 0;
  for (let current = 0; current < index; current += 1) position += editor.state.doc.child(current).nodeSize;
  return position;
}

/** Lightweight top-level block reordering without collaboration dependencies. */
export default function BlockDragHandle({ editor }: { editor: Editor }) {
  const [hovered, setHovered] = useState<{ index: number; top: number } | null>(null);
  const sourceIndex = useRef<number | null>(null);

  useEffect(() => {
    const root = editor.view.dom as HTMLElement;
    const update = (event: MouseEvent) => {
      if (sourceIndex.current !== null) return;
      const block = directBlock(event.target, root);
      if (!block) { setHovered(null); return; }
      const index = [...root.children].indexOf(block);
      if (index >= 0) setHovered({ index, top: block.offsetTop + Math.max(0, (block.offsetHeight - 27) / 2) });
    };
    const leave = (event: MouseEvent) => { if (!root.contains(event.relatedTarget as Node | null)) setHovered(null); };
    const dragOver = (event: DragEvent) => { if (sourceIndex.current !== null) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      const fromIndex = sourceIndex.current;
      sourceIndex.current = null;
      if (fromIndex === null) return;
      event.preventDefault();
      const block = directBlock(event.target, root);
      if (!block) return;
      const targetIndex = [...root.children].indexOf(block);
      if (targetIndex < 0) return;
      const afterTarget = event.clientY > block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2;
      let insertionIndex = targetIndex + (afterTarget ? 1 : 0);
      if (fromIndex < insertionIndex) insertionIndex -= 1;
      if (insertionIndex === fromIndex) return;
      const node = editor.state.doc.child(fromIndex);
      const from = positionAtIndex(editor, fromIndex);
      const transaction = editor.state.tr.delete(from, from + node.nodeSize);
      let insertAt = 0;
      for (let index = 0; index < insertionIndex; index += 1) insertAt += transaction.doc.child(index).nodeSize;
      transaction.insert(insertAt, node);
      editor.view.dispatch(transaction);
      editor.commands.setNodeSelection(insertAt);
      editor.view.focus();
    };
    const dragEnd = () => { sourceIndex.current = null; };
    root.addEventListener('mousemove', update);
    root.addEventListener('mouseleave', leave);
    root.addEventListener('dragover', dragOver);
    root.addEventListener('drop', drop);
    window.addEventListener('dragend', dragEnd);
    return () => {
      root.removeEventListener('mousemove', update);
      root.removeEventListener('mouseleave', leave);
      root.removeEventListener('dragover', dragOver);
      root.removeEventListener('drop', drop);
      window.removeEventListener('dragend', dragEnd);
    };
  }, [editor]);

  if (!hovered) return null;
  return <button
    className="editor-block-drag-handle"
    style={{ top: hovered.top }}
    draggable
    aria-label="拖动内容块"
    title="拖动内容块"
    onPointerDown={() => editor.commands.setNodeSelection(positionAtIndex(editor, hovered.index))}
    onDragStart={(event) => {
      sourceIndex.current = hovered.index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-opencanvas-editor-block', String(hovered.index));
    }}
  ><GripVertical size={15} /></button>;
}

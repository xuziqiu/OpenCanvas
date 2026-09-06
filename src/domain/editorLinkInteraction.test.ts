import { describe, expect, it } from 'vitest';
import { shouldOpenEditorLink } from './editorLinkInteraction';

describe('editor link interaction', () => {
  it('opens a link with one click on a readonly card', () => {
    expect(shouldOpenEditorLink({ editable: false })).toBe(true);
  });

  it('keeps a plain editing click available for caret placement', () => {
    expect(shouldOpenEditorLink({ editable: true })).toBe(false);
  });

  it('opens from the editor with the platform modifier', () => {
    expect(shouldOpenEditorLink({ editable: true, ctrlKey: true })).toBe(true);
    expect(shouldOpenEditorLink({ editable: true, metaKey: true })).toBe(true);
  });
});

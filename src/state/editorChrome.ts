import { create } from 'zustand';

/**
 * What a full-screen editor tool (the v3 Cutter) asks of the editor shell while it is open.
 * `ownsHistory`: the tool has the one undo stack and the one save indicator — the shell hides its
 * undo/redo and save chip and leaves Ctrl+Z alone. `compactNav`: the side nav shrinks to icons on
 * narrower screens so the tool gets the room.
 */
export const useEditorChrome = create<{ ownsHistory: boolean; compactNav: boolean }>(() => ({ ownsHistory: false, compactNav: false }));

import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';

const theme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--ink)',
      fontSize: '13.5px',
      height: '100%',
    },
    '.cm-content': {
      fontFamily: 'var(--mono)',
      padding: '12px 0 40px',
      caretColor: 'var(--accent)',
      lineHeight: '1.62',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--faint)',
      border: 'none',
      fontFamily: 'var(--mono)',
      fontSize: '12px',
      paddingLeft: '6px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(47, 111, 78, 0.045)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(47, 111, 78, 0.16) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--paper)', color: 'var(--ink)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--line)',
      color: 'var(--ink)',
    },
  },
  { dark: false },
);

export interface CodeEditor {
  get(): string;
  set(code: string): void;
  focus(): void;
  destroy(): void;
}

export function mountEditor(
  parent: HTMLElement,
  initial: string,
  onRun: () => void,
  onChange?: (code: string) => void,
): CodeEditor {
  const view = new EditorView({
    parent,
    doc: initial,
    extensions: [
      basicSetup,
      python(),
      theme,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => {
            onRun();
            return true;
          },
        },
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange?.(update.state.doc.toString());
      }),
    ],
  });

  return {
    get: () => view.state.doc.toString(),
    set: (code: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

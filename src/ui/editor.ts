import { basicSetup } from 'codemirror';
import { EditorView, keymap, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
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

export interface ErrorMark {
  line: number;
  colStart: number;
  colEnd: number;
}

export interface InlineFix {
  line: number;
  lines: number;
  removed: string[];
  added: string[];
  why: string;
  onApply: () => void;
  onDismiss: () => void;
}

/* ---------- error underline ---------- */

const setErrorEffect = StateEffect.define<ErrorMark | null>();
const setFixEffect = StateEffect.define<InlineFix | null>();

interface ErrorState {
  decorations: DecorationSet;
  mark: ErrorMark | null;
}

const errorField = StateField.define<ErrorState>({
  create: () => ({ decorations: Decoration.none, mark: null }),
  update(value, tr) {
    let next = tr.docChanged ? { decorations: Decoration.none, mark: null } : value;
    for (const effect of tr.effects) {
      if (!effect.is(setErrorEffect)) continue;
      const mark = effect.value;
      if (!mark) {
        next = { decorations: Decoration.none, mark: null };
        continue;
      }
      const doc = tr.state.doc;
      const info = doc.line(Math.min(Math.max(1, mark.line), doc.lines));
      const start = info.from + Math.min(Math.max(0, mark.colStart), info.length);
      const end = info.from + Math.min(Math.max(mark.colEnd, mark.colStart + 1), info.length);
      const decorations = [Decoration.line({ class: 'cm-error-line' }).range(info.from)];
      if (end > start) {
        decorations.push(Decoration.mark({ class: 'cm-error-span' }).range(start, end));
      }
      next = { decorations: Decoration.set(decorations, true), mark };
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/* ---------- inline fix card ---------- */

class FixWidget extends WidgetType {
  constructor(readonly fix: InlineFix) {
    super();
  }

  eq(other: FixWidget): boolean {
    return other.fix === this.fix;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-fix';

    const head = document.createElement('div');
    head.className = 'cm-fix-head';
    const where =
      this.fix.lines === 0
        ? `insert before line ${this.fix.line}`
        : this.fix.lines === 1
          ? `line ${this.fix.line}`
          : `lines ${this.fix.line}–${this.fix.line + this.fix.lines - 1}`;
    head.textContent = `Proposed fix · ${where}`;
    wrap.append(head);

    const diff = document.createElement('div');
    diff.className = 'cm-fix-diff';
    for (const line of this.fix.removed) {
      const row = document.createElement('div');
      row.className = 'cm-fix-line removed';
      row.textContent = `- ${line}`;
      diff.append(row);
    }
    if (this.fix.added.length === 0 && this.fix.removed.length > 0) {
      const row = document.createElement('div');
      row.className = 'cm-fix-line removed';
      row.textContent = '(line removed)';
      diff.append(row);
    }
    for (const line of this.fix.added) {
      const row = document.createElement('div');
      row.className = 'cm-fix-line added';
      row.textContent = `+ ${line}`;
      diff.append(row);
    }
    wrap.append(diff);

    if (this.fix.why) {
      const why = document.createElement('div');
      why.className = 'cm-fix-why';
      why.textContent = this.fix.why;
      wrap.append(why);
    }

    const actions = document.createElement('div');
    actions.className = 'cm-fix-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'cm-fix-apply';
    apply.textContent = 'Apply fix';
    apply.addEventListener('mousedown', (event) => event.preventDefault());
    apply.addEventListener('click', () => this.fix.onApply());

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'cm-fix-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('mousedown', (event) => event.preventDefault());
    dismiss.addEventListener('click', () => this.fix.onDismiss());

    actions.append(apply, dismiss);
    wrap.append(actions);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const fixField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFixEffect)) continue;
      const fix = effect.value;
      if (!fix) return Decoration.none;
      const doc = tr.state.doc;
      const info = doc.line(Math.min(Math.max(1, fix.line), doc.lines));
      return Decoration.set([Decoration.widget({ widget: new FixWidget(fix), block: true, side: 1 }).range(info.to)]);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ---------- public API ---------- */

export interface CodeEditor {
  get(): string;
  set(code: string): void;
  focus(): void;
  destroy(): void;
  markError(mark: ErrorMark | null): void;
  showFix(fix: InlineFix | null): void;
  revealLine(line: number): void;
  /** Replace `count` lines starting at `line`; returns the resulting text. */
  replaceLines(line: number, count: number, replacement: string[]): string;
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
      errorField,
      fixField,
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
    markError: (mark) => view.dispatch({ effects: setErrorEffect.of(mark) }),
    showFix: (fix) => view.dispatch({ effects: setFixEffect.of(fix) }),
    revealLine: (line) => {
      const doc = view.state.doc;
      const info = doc.line(Math.min(Math.max(1, line), doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(info.from, { y: 'center' }) });
      view.focus();
      const cursor = { from: info.from, to: info.to };
      view.dispatch({ selection: { anchor: cursor.from, head: cursor.to } });
    },
    replaceLines: (line, count, replacement) => {
      const doc = view.state.doc;
      const first = doc.line(Math.min(Math.max(1, line), doc.lines));
      const last = count > 0 ? doc.line(Math.min(first.number + count - 1, doc.lines)) : first;
      let to = count > 0 ? last.to : first.from;
      // Replacing a line with nothing should remove the line, not blank it.
      if (count > 0 && replacement.length === 0 && last.number < doc.lines) {
        to = doc.line(last.number + 1).from;
      }
      const insert =
        count === 0
          ? `${replacement.join('\n')}${replacement.length ? '\n' : ''}`
          : replacement.join('\n');
      view.dispatch({ changes: { from: first.from, to, insert } });
      return view.state.doc.toString();
    },
  };
}

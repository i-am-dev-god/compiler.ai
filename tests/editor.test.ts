// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mountEditor } from '../src/ui/editor';


const starter = 'def describe_age(age):\n    return "You are " + age + " years old"\n';

function mount(code = starter) {
  const host = document.createElement('div');
  document.body.append(host);
  const onRun = vi.fn();
  const editor = mountEditor(host, code, onRun);
  return { host, editor, onRun };
}

describe('editor: error highlight and inline fix', () => {
  it('underlines exactly the marked expression', () => {
    const { host, editor } = mount();
    editor.markError({ line: 2, colStart: 11, colEnd: 27 });
    const span = host.querySelector('.cm-error-span');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('"You are " + age');
    expect(host.querySelector('.cm-error-line')).not.toBeNull();
  });

  it('clears the mark when the program changes', () => {
    const { host, editor } = mount();
    editor.markError({ line: 2, colStart: 22, colEnd: 25 });
    expect(host.querySelector('.cm-error-span')).not.toBeNull();
    editor.replaceLines(2, 1, ['    return "You are " + str(age) + " years old"']);
    expect(host.querySelector('.cm-error-span')).toBeNull();
  });

  it('shows the proposed fix as a diff card and wires its buttons', () => {
    const { host, editor } = mount();
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    editor.showFix({
      line: 2,
      lines: 1,
      removed: ['    return "You are " + age + " years old"'],
      added: ['    return "You are " + str(age) + " years old"'],
      why: 'age is an int; str() makes it text',
      onApply,
      onDismiss,
    });
    const card = host.querySelector('.cm-fix');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Proposed fix · line 2');
    expect(card?.querySelector('.cm-fix-line.removed')?.textContent).toBe('-     return "You are " + age + " years old"');
    expect(card?.querySelector('.cm-fix-line.added')?.textContent).toBe('+     return "You are " + str(age) + " years old"');
    expect(card?.textContent).toContain('age is an int; str() makes it text');

    (card?.querySelector('.cm-fix-apply') as HTMLButtonElement).click();
    (card?.querySelector('.cm-fix-dismiss') as HTMLButtonElement).click();
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('replaces, inserts and removes lines without touching the rest', () => {
    const { editor } = mount();
    expect(editor.replaceLines(2, 1, ['    return f"You are {age} years old"'])).toBe(
      'def describe_age(age):\n    return f"You are {age} years old"\n',
    );

    const inserted = mount('def total_price(prices):\n    for price in prices:\n        total += price\n');
    const got = inserted.editor.replaceLines(2, 0, ['    total = 0']);
    expect(got).toBe(
      'def total_price(prices):\n    total = 0\n    for price in prices:\n        total += price\n',
    );

    const removed = mount('x = 1\nprint(x)\n');
    expect(removed.editor.replaceLines(1, 1, [])).toBe('print(x)\n');
  });
});

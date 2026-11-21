import type { PyError } from '../runner/types';
import type { Challenge } from '../data/challenges';

/**
 * Help that costs nothing: no model, no download, no network. Every error gets
 * one question that points at the concept instead of the corrected line, so the
 * editor, runner and tests are genuinely useful with the AI switched off.
 */

const ERROR_QUESTIONS: Record<string, string> = {
  NameError: 'Python does not recognise a name on this line. Where is that name created, and is that line reached before this one runs?',
  UnboundLocalError:
    'The variable is local to this function but read before it was given a value. Which line is supposed to create it, and does that line exist yet?',
  TypeError:
    'A TypeError means a value had the wrong type for the operation. Look at the two values on this line - what type is each one, and what does the operator expect?',
  IndexError:
    'The index used here is outside the list. What is the last valid index of this list, and what is the index at this point in the loop?',
  KeyError: 'That key is not in the dictionary. Is the key spelled the way it was stored, and is it guaranteed to exist at this point?',
  ZeroDivisionError: 'Something here divides by zero. Which value is the divisor, and what would make it zero?',
  ValueError: 'The value has the right type but an unusable content. What did the function expect, and what did it actually receive?',
  SyntaxError: 'Python could not parse the line rather than run it. Read it slowly - is a colon, bracket or quote missing or unbalanced?',
  IndentationError: 'Python uses indentation as structure. Is this line indented to the same level as the lines it belongs with?',
  AttributeError: 'The value on the left of the dot does not have that attribute. What type is it actually, and where was it created?',
  RecursionError: 'The function keeps calling itself. What is the input that should stop the recursion, and is that case reached?',
  Timeout: 'The program was still running after the time limit. Which loop could keep going without its condition ever becoming false?',
  OutputLimit: 'The program printed an enormous amount of text. Which loop prints without ever ending?',
};

export function questionForError(error: PyError | null | undefined): string {
  if (!error) return 'The program ran without an error. Compare the output with what you expected - which value is the first one that differs?';
  const base = ERROR_QUESTIONS[error.type];
  if (base) return base;
  return `Python raised ${error.type}${error.line ? ` on line ${error.line}` : ''}. Read that message as a sentence: which value does it name, and what was the program trying to do with it?`;
}

export interface BuiltinHelpOptions {
  challenge?: Challenge | null;
  error?: PyError | null;
}

/** The deterministic hint shown when no model is available or the model is blocked. */
export function builtinHint(options: BuiltinHelpOptions): string {
  if (options.challenge) return options.challenge.fallbackHint;
  return questionForError(options.error);
}

export function explainWithoutModel(options: BuiltinHelpOptions): string {
  const { challenge, error } = options;
  if (error) {
    const where = error.line ? ` on line ${error.line}` : '';
    return `Python raised ${error.type}${where}: ${error.message} ${questionForError(error)}`;
  }
  if (challenge) {
    return `The program ran, so the bug is in the logic rather than the syntax. ${challenge.fallbackHint}`;
  }
  return 'The program ran. If the result is not what you wanted, find the first value that differs from what you expected and work backwards from there.';
}

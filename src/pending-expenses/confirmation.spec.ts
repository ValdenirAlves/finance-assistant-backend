import { pendingAction } from './confirmation.js';

describe('deterministic pending expense confirmation', () => {
  it.each([
    'Yes',
    'Yes, save it.',
    'Save it.',
    'Confirm',
    'Go ahead.',
    'Sim',
    'Pode salvar',
    'Confirma',
    '  YES, SAVE IT!  ',
  ])('recognizes the entire explicit confirmation %s', (message) => {
    expect(pendingAction(message)).toBe('confirm');
  });

  it.each([
    'Yes, save it, but change the amount first.',
    'Do not save it yet',
    'How much did I spend?',
    'He said yes, save it.',
  ])('does not infer confirmation from a substring: %s', (message) => {
    expect(pendingAction(message)).toBeNull();
  });
});

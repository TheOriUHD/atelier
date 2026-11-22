import { describe, expect, it } from 'vitest';
import { hasErrors, newDecideForm, newOption, newQuestion, toDecideInput, validateDecideForm, withType, type DecideForm, type QuestionDraft } from './decide-form.ts';

const question = (type: QuestionDraft['type'], instructions: string, values: string[] = []): QuestionDraft => ({ ...newQuestion(type), instructions, options: values.map((v) => newOption(v)) });
const form = (...questions: QuestionDraft[]): DecideForm => ({ state: 'Hi Ada, can you send the invoice by Friday?', questions });
const problems = (f: DecideForm) => Object.values(validateDecideForm(f).questions);

describe('the Decide form', () => {
  it('starts with one yes-or-no question and nothing to send', () => {
    const start = newDecideForm();
    expect(start.questions.map((q) => q.type)).toEqual(['yesno']);
    const errors = validateDecideForm(start);
    expect(errors.state).toBe('Write or paste what to decide about.');
    expect(Object.values(errors.questions)).toEqual([{ instructions: 'Write the question.' }]);
  });

  it('gives a choice or a score two rows to fill in, and keeps them when switched back', () => {
    const choice = withType(newQuestion(), 'choice');
    expect(choice.options).toHaveLength(2);
    const filled = { ...choice, options: [newOption('Billing'), newOption('Support'), newOption('Sales')] };
    expect(withType(withType(filled, 'yesno'), 'choice').options.map((o) => o.value)).toEqual(['Billing', 'Support', 'Sales']);
  });

  it('checks what the backend’s schema checks', () => {
    expect(problems(form(question('choice', 'Topic?', ['Billing', ''])))).toEqual([{ options: 'A choice needs at least two options.' }]);
    expect(problems(form(question('choice', 'Topic?', ['Billing', ' Billing '])))).toEqual([{ options: 'Two options have the same name.' }]);
    expect(problems(form(question('score', 'Urgency?', ['Low'])))).toEqual([{ options: 'A score needs 2 to 10 levels.' }]);
    expect(problems(form(question('score', 'Urgency?', Array.from({ length: 11 }, (_, i) => `L${i}`))))).toEqual([{ options: 'A score needs 2 to 10 levels.' }]);
    expect(problems(form(question('score', 'Urgency?', ['Low', 'Low'])))).toEqual([{ options: 'Two levels have the same name.' }]);
    const nameless = question('choice', 'Topic?', ['Billing', 'Support']);
    nameless.options.push({ ...newOption(), description: 'Anything about money' });
    expect(problems(form(nameless))).toEqual([{ options: 'Give every option with a description a name too.' }]);
    expect(hasErrors(validateDecideForm(form(question('yesno', 'Does it ask for a reply?'), question('choice', 'Topic?', ['Billing', 'Support']))))).toBe(false);
  });

  it('names the questions q1, q2… and leaves empty rows and empty descriptions out', () => {
    const choice = question('choice', ' What is it about? ', ['Billing', '', 'Support']);
    choice.options[0]!.description = ' Invoices and payments ';
    // Options a yes-or-no question kept from before are not sent.
    const yesno = { ...question('yesno', 'Does it ask for a reply?'), options: [newOption('Left over')] };
    expect(toDecideInput(form(yesno, choice, question('score', 'How urgent?', ['Low', 'High'])), 'service:typesafe:jev-latest')).toEqual({
      state: 'Hi Ada, can you send the invoice by Friday?',
      questions: [
        { name: 'q1', type: 'yesno', instructions: 'Does it ask for a reply?' },
        { name: 'q2', type: 'choice', instructions: 'What is it about?', options: [{ value: 'Billing', description: 'Invoices and payments' }, { value: 'Support' }] },
        { name: 'q3', type: 'score', instructions: 'How urgent?', options: [{ value: 'Low' }, { value: 'High' }] },
      ],
      source: 'service:typesafe:jev-latest',
    });
  });
});

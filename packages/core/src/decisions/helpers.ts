/**
 * Atelier's own small choices by the decision model (ARCHITECTURE §28), each with its way without one: which engines a
 * web search goes to, and whether a conversation holds anything worth remembering. A tenth of a second each, on a model
 * that reads them as a person would instead of by keywords.
 */
import type { DecisionQuestion } from '@atelier/protocol';
import type { Topic } from '../search/types.ts';
import type { DecisionService } from './service.ts';

const TOPIC: DecisionQuestion = {
  name: 'topic',
  type: 'choice',
  instructions: 'This is a web search query. What is it about?',
  options: [
    { value: 'news', description: 'Current events: recent news, announcements, results, releases, prices or anything that changes from day to day.' },
    { value: 'dev', description: 'Programming: code, errors, libraries, frameworks, tools, APIs or software development.' },
    { value: 'general', description: 'Anything else: facts, how-tos, products, places, people, definitions.' },
  ],
};

/** A topic only this sure counts; below, the query's words decide. */
const TOPIC_SURE = 0.6;

export async function searchTopic(service: DecisionService, query: string, signal: AbortSignal): Promise<Topic | null> {
  const result = await service.ask(query, [TOPIC], { purpose: 'web search topic', priority: 'foreground', timeoutMs: 2_000, signal });
  const answer = result?.answers[0];
  if (answer?.type !== 'choice') return null;
  const p = answer.probabilities.find((x) => x.value === answer.choice)?.probability ?? 0;
  return p >= TOPIC_SURE ? (answer.choice as Topic) : null;
}

const REMEMBER: DecisionQuestion = {
  name: 'remember',
  type: 'yesno',
  instructions:
    'This is part of a conversation between a person and their AI assistant. Does it show something lasting worth remembering for their later conversations: a preference, a fact about them, their work or their people, a decision, an ongoing project, or something they asked to be remembered? Small talk and one-off questions don’t count.',
};

/** Below this, nothing is kept and the memory model isn't asked; anything else is left to it. */
const NOTHING_BELOW = 0.15;

export async function worthRemembering(service: DecisionService, transcript: string): Promise<boolean | null> {
  const result = await service.ask(transcript.slice(-24_000), [REMEMBER], { purpose: 'memory', priority: 'background', timeoutMs: 30_000 });
  const answer = result?.answers[0];
  if (answer?.type !== 'yesno') return null;
  return answer.probability < NOTHING_BELOW ? false : null;
}

// Which placement test a new learner gets: the classic five-part test (server/session.js) or the conversation
// (./conversation.js). Chosen in the admin console (Settings › Placement test); a test keeps the kind it started as.
import * as settings from '../settings.js';
import * as classic from '../session.js';
import * as conversation from './conversation.js';

export const getSession = (id) => classic.getSession(id) || conversation.getSession(id);
export const startSession = () => (settings.get('placement').mode === 'conversation' ? conversation.startSession() : classic.startSession());
/** opts.onReply(lines): conversation only, with a model that streams: her reaction's lines before the turn is finished. */
export const handleTurn = (s, input, trace, opts = {}) => (s.mode === 'conversation' ? conversation.handleTurn(s, input, trace, opts) : classic.handleTurn(s, input, trace));
/** The fixed lines of both tests (generated ahead; always allowed to be spoken). */
export function scriptedLines() {
  const all = [...conversation.scriptedLines(), ...classic.scriptedLines()]; // the conversation (the default) first: its lines are made first
  return [...new Map(all.map((l) => [`${l.text}|${l.pace}`, l])).values()];
}

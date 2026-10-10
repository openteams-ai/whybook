/**
 * Who asked a question, from JupyterLab's user: `app.serviceManager.user`,
 * whose identity comes from the server's /api/me. A question that the
 * analyst asks records the username and the display name, in
 * `asked_by_person`, and the guess records them too. Cell details names the
 * person from that record.
 */
import type { User } from '@jupyterlab/services';

import type { IEpiCellMeta, IPerson } from '../tokens';

/**
 * The username that jupyter_server gives a login by token or password, and
 * every user of a server without a login: `uuid.uuid4().hex`, 32 hex digits,
 * with 4 for the UUID's version and 8, 9, a or b for its variant
 * (`generate_anonymous_user` in jupyter_server/auth/identity.py; the login
 * handlers of before jupyter_server 2.0 make the same). Its name, such as
 * "Anonymous Io", can be changed through /api/me; the username cannot. Each
 * new browser gets another one, and so does a login after the cookie ends.
 */
const ANONYMOUS_USERNAME = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

/**
 * Whether a username is jupyter_server's anonymous user: a random one, or
 * "anonymous", which the login handlers of before jupyter_server 2.0 give on a
 * server without a login. JupyterHub's user, as on Nebari, is a real one.
 */
export function isAnonymous(username: string): boolean {
  return username === 'anonymous' || ANONYMOUS_USERNAME.test(username);
}

/**
 * The person to record for JupyterLab's user: its username and its display
 * name. Null for an anonymous user, and for a page whose user is not known:
 * before /api/me answers, on a server without it, and in JupyterLite.
 */
export function personOf(
  identity: User.IIdentity | null | undefined
): IPerson | null {
  const username = identity?.username;
  if (typeof username !== 'string' || !username || isAnonymous(username)) {
    return null;
  }
  const name = identity?.display_name || identity?.name || username;
  return { username, name: name.trim() || username };
}

/** A person as the notebook records it, or null for a record without a username. */
function recorded(value: unknown): IPerson | null {
  const person = value as Partial<IPerson> | null | undefined;
  if (typeof person?.username !== 'string' || !person.username) {
    return null;
  }
  const name = typeof person.name === 'string' ? person.name.trim() : '';
  return { username: person.username, name: name || person.username };
}

/** Whether the notebook records the user of the page: the same username. */
function isUser(person: IPerson | null, user: IPerson | null): boolean {
  return !!person && !!user && person.username === user.username;
}

/**
 * Who asked the question of a cell, in words for Cell details: "You" when
 * the notebook records the user of the page, the person's name when it
 * records another person, and "A person" when it records no one, as for an
 * anonymous user, the demos and older notebooks. `user` is the page's.
 */
export function askedLine(
  meta: IEpiCellMeta,
  user: IPerson | null
): string | null {
  if (meta.asked_by === 'agent') {
    return 'An AI model asked it.';
  }
  if (!meta.question) {
    return null;
  }
  const person = recorded(meta.asked_by_person);
  if (isUser(person, user)) {
    return 'You asked it.';
  }
  return `${person ? person.name : 'A person'} asked it.`;
}

/**
 * Whose guess before the result a cell keeps, by the rule of `askedLine`:
 * "Your guess" for the user of the page, and "Their guess" when the line
 * before names the same person, or names no one and the guess records no
 * one either. Otherwise the guess names its own person: an answer that
 * edits a cell in place keeps the cell's question, and its guess can be
 * another person's.
 */
export function guessWho(meta: IEpiCellMeta, user: IPerson | null): string {
  const guesser = recorded(meta.guess?.person);
  if (isUser(guesser, user)) {
    return 'Your guess';
  }
  const asker = recorded(meta.asked_by_person);
  if (
    meta.question &&
    meta.asked_by !== 'agent' &&
    !isUser(asker, user) &&
    asker?.username === guesser?.username
  ) {
    return 'Their guess';
  }
  return guesser ? `${guesser.name}'s guess` : "A person's guess";
}

import { randomBytes, createHash } from 'node:crypto';
import { verifyEvent, nip19 } from 'nostr-tools';

export const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
export const now = () => Math.floor(Date.now() / 1000);
const authError = () => Object.assign(new Error('Sign-in failed. Use an authorised admin key and a fresh challenge.'), { statusCode: 401 });

export class Auth {
  constructor(store, admins, origin) { this.store = store; this.admins = admins; this.origin = origin; }
  challenge() {
    this.store.cleanup();
    const count = this.store.db.prepare('SELECT count(*) AS n FROM challenges').get().n;
    if (count >= 1000) throw Object.assign(new Error('Too many sign-in attempts. Please try again later.'), { statusCode: 429 });
    const token = random(), nonce = random();
    this.store.db.prepare('INSERT INTO challenges VALUES (?,?,?)').run(hash(token), nonce, now() + 120);
    return { token, event: { kind: 27235, created_at: now(), content: '', tags: [['u', `${this.origin}/api/auth/login`], ['method', 'POST'], ['challenge', nonce]] } };
  }
  login(token, event) {
    const row = this.store.db.prepare('DELETE FROM challenges WHERE token=? RETURNING *').get(hash(token || ''));
    const expectedTags = row && JSON.stringify([['u', `${this.origin}/api/auth/login`], ['method', 'POST'], ['challenge', row.nonce]]);
    // Reject cheap invalid/replayed requests before doing signature verification.
    if (!row || row.expires < now() || !event || !this.admins.includes(event.pubkey) || event.kind !== 27235 ||
      !Number.isInteger(event.created_at) || Math.abs(event.created_at - now()) > 120 || event.content !== '' ||
      JSON.stringify(event.tags) !== expectedTags) throw authError();
    let verified = false;
    try { verified = verifyEvent(event); } catch {}
    if (!verified) throw authError();
    const session = random();
    this.store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(session), event.pubkey, now() + 43200);
    return session;
  }
  session(token) {
    const row = token && this.store.db.prepare('SELECT pubkey FROM sessions WHERE token=? AND expires>?').get(hash(token), now());
    return row && this.admins.includes(row.pubkey) ? { authenticated: true, pubkey: row.pubkey, npub: nip19.npubEncode(row.pubkey) } : { authenticated: false, configured: this.admins.length > 0 };
  }
  logout(token) { if (token) this.store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); }
}

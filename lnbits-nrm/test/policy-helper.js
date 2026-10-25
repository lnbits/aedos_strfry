import { Policy } from '../server/policy.js';
export class ReloadedPolicy extends Policy {
  constructor(store) { super(store.settings()); this.store = store; }
  decide(message, now) {
    const settings = this.store.settings();
    if (settings.revision !== this.settings.revision) this.update(settings);
    return super.decide(message, now);
  }
}

// Team roles and what each may do to another dev's threads (the role dialog: docs/mocks/team/s4-role.png). The relay never sees these: they
// travel sealed inside the roster the lead signs, and each dev's Yes Chef checks them before it acts.
// Words: the map Dan approved on 2026-11-10. The defaults below Deputy are proposed, not ruled.

export const ROLES = ['lead', 'deputy', 'owner', 'engineer', 'viewer'];
export const ROLE_NAMES = { lead: 'Lead', deputy: 'Deputy', owner: 'Area owner', engineer: 'Engineer', viewer: 'Viewer' };

/** The role dialog's boxes (S4), in developer words. `see` is every role's and cannot be unticked. */
export const PERMS = [
  { key: 'see', label: 'See every ticket in the projects the team shares', hint: 'Every role can. Each dev picks their own projects.', locked: true },
  { key: 'reply', label: 'Reply on anyone\'s ticket', hint: 'The reply goes to that dev\'s thread, with your name on it.' },
  { key: 'projects', label: 'Edit the projects and the shared code list' },
  { key: 'merge', label: 'Merge, Request changes or Hold at Ready to merge', hint: 'Every ticket in a French Brigade area. Only shared code changes in an Open kitchen area.' },
  { key: 'invite', label: 'Invite people' },
  { key: 'rules', label: 'Change the mode and Rules' },
];
const KEYS = PERMS.map((p) => p.key);

/** Each role's boxes before the lead changes them. The Deputy's are S4's. */
export const DEFAULTS = {
  lead: KEYS,
  deputy: ['see', 'reply', 'projects', 'invite'],
  owner: ['see', 'reply', 'merge'],
  engineer: ['see'],
  viewer: ['see'],
};

/** A Viewer sees the team and runs no agents for it, so a Viewer's Yes Chef sends no summary. */
export const shares = (role) => role !== 'viewer';

/** A role and its boxes, cleaned: a known role, known boxes, `see` always, and the lead always has every box. */
export function grant(role, perms) {
  const r = ROLES.includes(role) ? role : 'viewer';
  if (r === 'lead') return { role: r, perms: [...KEYS] };
  const want = new Set(Array.isArray(perms) ? perms : DEFAULTS[r]);
  want.add('see');
  return { role: r, perms: KEYS.filter((k) => want.has(k)) };
}

/** What a teammate's action needs. Settle and New thread never come from a teammate: they stay the dev's own. */
export const NEEDS = { reply: 'reply', go: 'merge', refire: 'merge', hold: 'merge', answer: 'merge', call: 'merge' };

/** May this member do this action to another dev's thread? member: { role, perms }. */
export function allows(member, kind) {
  const need = NEEDS[kind];
  if (!need || !member) return false;
  const g = grant(member.role, member.perms);
  return g.perms.includes(need);
}

/** The words a refusal shows the sender, in the dev's own Yes Chef's voice. */
export function refusal(member, kind) {
  if (!NEEDS[kind]) return 'A teammate cannot do that. Only the dev can.';
  const label = PERMS.find((p) => p.key === NEEDS[kind]).label;
  return `Your role (${ROLE_NAMES[grant(member?.role).role]}) does not include: ${label}. Ask the lead.`;
}

/** The line Yes Chef puts before a teammate's action in the dev's thread, so the agent and the dev see who sent it. */
export function signature(member) {
  const name = String(member?.name || 'A teammate').replace(/\s+/g, ' ').trim().slice(0, 60) || 'A teammate';
  return `${name} (${ROLE_NAMES[grant(member?.role).role]}), from Yes Chef: `;
}

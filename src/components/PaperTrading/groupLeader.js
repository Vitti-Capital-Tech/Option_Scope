// Group leader (migration 064): the account a group's other members follow. Falls back to the
// group's first-created member when none is set, or when the saved leader has left the group.
export function groupLeaderId(group, accounts) {
  if (!group) return null;
  const members = accounts.filter(a => a.group_id === group.id);
  if (group.leader_account_id && members.some(a => a.id === group.leader_account_id)) return group.leader_account_id;
  const first = [...members].sort((a, b) => (new Date(a.created_at) - new Date(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
  return first?.id ?? null;
}

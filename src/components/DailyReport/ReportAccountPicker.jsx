import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Columns, CornerDownRight, Layers, Pencil, Users } from 'lucide-react';

// Daily Report account picker, styled like the Live Trading account dropdown
// (AccountSelectorStrip): "All live accounts", then each name group as one row whose members
// expand underneath, then the accounts that are in no group. Picking a group row combines its
// members; picking a member opens that account alone.
export default function ReportAccountPicker({ accounts, groups, value, onChange, onEditGroups }) {
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const groupOf = (id) => groups.find(g => g.ids.includes(id));
  const selectedGroup = groups.find(g => g.key === value);
  const selectedAccount = accounts.find(a => a.id === value);
  const ungrouped = accounts.filter(a => !groupOf(a.id));

  // Opening the menu expands the group of the selected account, so the selection is visible.
  const toggleMenu = () => {
    const g = selectedAccount ? groupOf(selectedAccount.id) : null;
    if (!isOpen && g) setExpanded(s => (s.has(g.key) ? s : new Set(s).add(g.key)));
    setIsOpen(o => !o);
  };
  const toggleGroup = (key) => setExpanded(s => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const pick = (v) => { onChange(v); setIsOpen(false); };

  const item = (key, v, icon, label, { nested = false, sub = null } = {}) => (
    <button key={key} type="button"
      className={`account-dropdown-item ${value === v ? 'selected' : ''} ${nested ? 'nested' : ''}`}
      onClick={() => pick(v)}>
      <div className="account-dropdown-item-left">
        {icon}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
        {sub}
      </div>
      {value === v && <Check className="account-selected-checkmark" size={14} strokeWidth={3} stroke="var(--accent)" />}
    </button>
  );

  const groupBadge = (n) => (
    <span className="dr-group-badge" title={`${n} accounts combined`}><Users size={9} strokeWidth={2.5} /> {n}</span>
  );

  const triggerLabel = value === 'all' ? 'All live accounts'
    : selectedGroup ? selectedGroup.label : (selectedAccount?.name ?? 'Select account');

  return (
    <div className="account-dropdown-container dr-account-picker" ref={ref}>
      <button type="button" className="account-dropdown-trigger" onClick={toggleMenu} aria-expanded={isOpen}>
        <div className="account-dropdown-trigger-content" style={{ minWidth: 0 }}>
          {value === 'all' ? <Layers className="account-icon-avatar" size={14} strokeWidth={2.5} />
            : selectedGroup ? <Users className="account-icon-avatar" size={14} strokeWidth={2.5} stroke="#a371f7" />
            : <Columns className="account-icon-avatar" size={14} strokeWidth={2.5} />}
          <span className="account-dropdown-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerLabel}</span>
          {selectedGroup && groupBadge(selectedGroup.ids.length)}
        </div>
        <ChevronDown className="account-chevron-icon" size={12} strokeWidth={2.5}
          style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease', flexShrink: 0 }} />
      </button>

      {isOpen && (
        <div className="account-dropdown-menu">
          <div className="account-dropdown-menu-header">Select account</div>
          <div className="account-dropdown-list">
            {item('all', 'all', <Layers className="account-dropdown-item-icon" size={14} strokeWidth={2.5} />, 'All live accounts',
              { sub: groupBadge(accounts.length) })}
            {groups.map(g => {
              const open = expanded.has(g.key);
              const members = accounts.filter(a => g.ids.includes(a.id));
              return (
                <div key={g.key} className="account-dropdown-group">
                  <div className="account-dropdown-group-row">
                    {item(g.key, g.key, <Users className="account-dropdown-item-icon" size={14} strokeWidth={2.5} stroke="#a371f7" />, g.label,
                      { sub: groupBadge(members.length) })}
                    <button type="button" className="account-dropdown-expand" onClick={() => toggleGroup(g.key)}
                      title={open ? 'Hide the accounts in this group' : `Show ${g.names.join(', ')}`} aria-expanded={open}>
                      <ChevronRight size={12} strokeWidth={2.5}
                        style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }} />
                    </button>
                  </div>
                  {open && members.map(a => item(a.id, a.id,
                    <CornerDownRight className="account-dropdown-item-icon" size={13} strokeWidth={2.5} />, a.name, { nested: true }))}
                </div>
              );
            })}
            {ungrouped.map(a => item(a.id, a.id, <Columns className="account-dropdown-item-icon" size={14} strokeWidth={2.5} />, a.name))}
          </div>
          {onEditGroups && (
            <button type="button" className="account-dropdown-item dr-edit-groups"
              onClick={() => { setIsOpen(false); onEditGroups(); }}>
              <div className="account-dropdown-item-left">
                <Pencil className="account-dropdown-item-icon" size={13} strokeWidth={2.5} />
                <span>Edit groups</span>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

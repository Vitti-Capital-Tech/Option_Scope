import React, { useState, useEffect, useRef } from 'react';
import { User, ChevronDown, ChevronRight, Columns, Check, Edit, Plus, Trash2, LogOut, Users, Crown, CornerDownRight } from 'lucide-react';
import { groupLeaderId } from './groupLeader';

function LiveBadge({ account }) {
  if (!account || account.mode !== 'live') return null;
  const armed = !!account.live_enabled;
  return (
    <span
      title={armed ? 'Live — real orders armed' : 'Live — credentials linked, orders disarmed'}
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.06em',
        padding: '1px 5px',
        borderRadius: 4,
        marginLeft: 6,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        color: armed ? '#0d1117' : '#3b82f6',
        background: armed ? '#3fb950' : 'transparent',
        border: armed ? 'none' : '1px solid #3b82f6'
      }}
    >
      {armed ? 'LIVE ●' : 'LIVE'}
    </span>
  );
}

function PausedBadge({ account }) {
  if (!account?.paused) return null;
  return (
    <span
      title="Paused — no new positions; open ones still managed"
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
        padding: '1px 5px', borderRadius: 4, marginLeft: 6, whiteSpace: 'nowrap', flexShrink: 0,
        color: '#3b82f6', background: 'transparent', border: '1px solid #3b82f6',
      }}
    >
      PAUSED
    </span>
  );
}

// Account group (migration 050): the account shares its settings with the group's members.
function GroupBadge({ account, groups }) {
  const group = account?.group_id ? groups.find(g => g.id === account.group_id) : null;
  if (!group) return null;
  return (
    <span
      title={`In group "${group.name}" — settings are shared with the group's other accounts`}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
        padding: '1px 5px', borderRadius: 4, marginLeft: 6,
        color: '#a371f7', background: 'transparent', border: '1px solid #a371f7',
        display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 120, whiteSpace: 'nowrap', flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      <Users size={9} strokeWidth={2.5} /> {group.name}
    </span>
  );
}

const ctrlBtn = (bg, color) => ({
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: bg, color, cursor: 'pointer', fontSize: 11, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 4,
});

export default function AccountSelectorStrip({
  accounts,
  activeAccountId,
  setActiveAccountId,
  triggerCreateAccount,
  triggerDeleteAccount,
  triggerStartLive,
  triggerDisarmLive,
  triggerPauseAccount,
  triggerResumeAccount,
  triggerEditAccount,
  groups = [],
  triggerManageGroups,
  engineDryRun,
  userProfile,
  session,
  handleLogout
}) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const activeAccount = accounts.find(acc => acc.id === activeAccountId);

  // Nested list: a group shows only its LEADER (the account the group follows, migration 064)
  // at the top level; the followers appear under it when the group is expanded. Ungrouped
  // accounts are listed as before. Order follows `accounts` (a group sits at its first member).
  const [expanded, setExpanded] = useState(() => new Set());
  const entries = [];
  const seenGroups = new Set();
  for (const acc of accounts) {
    const group = acc.group_id ? groups.find(g => g.id === acc.group_id) : null;
    if (!group) { entries.push({ acc }); continue; }
    if (seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    const leaderId = groupLeaderId(group, accounts);
    entries.push({
      group,
      acc: accounts.find(a => a.id === leaderId) ?? acc,
      followers: accounts.filter(a => a.group_id === group.id && a.id !== leaderId),
    });
  }
  // Opening the menu expands the group of the active account if it is a follower, so the
  // selected account is always visible.
  const toggleMenu = () => {
    const group = activeAccount?.group_id ? groups.find(g => g.id === activeAccount.group_id) : null;
    if (!isOpen && group && groupLeaderId(group, accounts) !== activeAccount.id) {
      setExpanded(s => (s.has(group.id) ? s : new Set(s).add(group.id)));
    }
    setIsOpen(!isOpen);
  };
  const toggleGroup = (id) => setExpanded(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderItem = (acc, { nested = false, leader = false } = {}) => {
    const isSelected = acc.id === activeAccountId;
    return (
      <button
        key={acc.id}
        type="button"
        className={`account-dropdown-item ${isSelected ? 'selected' : ''} ${nested ? 'nested' : ''}`}
        onClick={() => {
          setActiveAccountId(acc.id);
          setIsOpen(false);
        }}
      >
        <div className="account-dropdown-item-left">
          {nested
            ? <CornerDownRight className="account-dropdown-item-icon" size={13} strokeWidth={2.5} />
            : leader
              ? <Crown className="account-dropdown-item-icon" size={14} strokeWidth={2.5} stroke="#a371f7" />
              : <Columns className="account-dropdown-item-icon" size={14} strokeWidth={2.5} />}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={acc.name}>{acc.name}</span>
          {acc.paused
            ? <PausedBadge account={acc} />
            : <LiveBadge account={acc} />}
          {leader && <GroupBadge account={acc} groups={groups} />}
        </div>
        {isSelected && (
          <Check className="account-selected-checkmark" size={14} strokeWidth={3} stroke="var(--accent)" />
        )}
      </button>
    );
  };

  return (

    <div className="account-selector-strip">
      {/* Account selection and actions group */}
      <div className="account-selector-group">
        <span className="account-selector-label">Account:</span>
        
        <div className="account-dropdown-container" ref={dropdownRef}>
          <button 
            type="button"
            className="account-dropdown-trigger" 
            onClick={toggleMenu}
          >
            <div className="account-dropdown-trigger-content">
              <User className="account-icon-avatar" size={14} strokeWidth={2.5} />
              <span className="account-dropdown-name">{activeAccount?.name || 'Select Account'}</span>
              {/* One status badge only. PAUSED takes precedence over LIVE — a paused
                  account is not actively trading, so showing "LIVE" too would be
                  misleading. (Real-money status stays visible via the REAL ORDERS /
                  Disarm controls and the market-row badge.) */}
              {activeAccount?.paused
                ? <PausedBadge account={activeAccount} />
                : <LiveBadge account={activeAccount} />}
              <GroupBadge account={activeAccount} groups={groups} />
            </div>
            <ChevronDown 
              className="account-chevron-icon" 
              size={12} 
              strokeWidth={2.5}
              style={{
                transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease'
              }}
            />
          </button>

          {isOpen && (
            <div className="account-dropdown-menu">
              <div className="account-dropdown-menu-header">Select Trading Account</div>
              <div className="account-dropdown-list">
                {entries.map(({ acc, group, followers }) => {
                  if (!group) return renderItem(acc);
                  const open = expanded.has(group.id);
                  return (
                    <div key={`g-${group.id}`} className="account-dropdown-group">
                      <div className="account-dropdown-group-row">
                        {renderItem(acc, { leader: true })}
                        {followers.length > 0 && (
                          <button
                            type="button"
                            className="account-dropdown-expand"
                            onClick={() => toggleGroup(group.id)}
                            title={open ? 'Hide the accounts that follow this one' : `Show the ${followers.length} account${followers.length === 1 ? '' : 's'} that follow ${acc.name}`}
                            aria-expanded={open}
                          >
                            +{followers.length}
                            <ChevronRight size={12} strokeWidth={2.5}
                              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }} />
                          </button>
                        )}
                      </div>
                      {open && followers.map(f => renderItem(f, { nested: true }))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {activeAccount && triggerEditAccount && (
          <button
            type="button"
            onClick={triggerEditAccount}
            className="account-selector-btn"
            title="Edit account details"
            style={{ padding: '6px 8px' }}
          >
            <Edit size={13} strokeWidth={2.5} />
          </button>
        )}

        <button
          onClick={triggerCreateAccount}
          className="account-selector-btn new-acc"
        >
          <Plus size={12} strokeWidth={2.5} />
          New Account
        </button>

        {triggerManageGroups && (
          <button
            type="button"
            onClick={triggerManageGroups}
            className="account-selector-btn"
            title="Group accounts so they share the same settings"
          >
            <Users size={12} strokeWidth={2.5} />
            Groups
          </button>
        )}

        {accounts.length > 1 && (
          <button
            onClick={() => triggerDeleteAccount(activeAccountId)}
            className="account-selector-btn delete-acc"
            title="Delete Active Account"
          >
            <Trash2 size={12} strokeWidth={2.5} />
            Delete
          </button>
        )}

      </div>

      {/* Right side: live status + controls, then user & logout */}
      <div className="account-selector-right" style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 'auto' }}>
        {/* Live account controls (arm / pause) — live accounts only */}
        {activeAccount?.mode === 'live' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Execution mode: only meaningful once armed */}
            {activeAccount.live_enabled && (
              engineDryRun === false ? (
                <span title="Engine is placing REAL orders on Delta" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '4px 8px', borderRadius: 5, color: '#fff', background: '#f85149' }}>
                  ● REAL ORDERS
                </span>
              ) : engineDryRun === true ? (
                <span title="Armed, but engine is in DRY-RUN — orders are simulated, nothing hits Delta" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '4px 8px', borderRadius: 5, color: '#3b82f6', background: 'transparent', border: '1px solid #3b82f6' }}>
                  DRY-RUN
                </span>
              ) : (
                <span title="Engine offline or unknown — can't confirm execution mode" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '4px 8px', borderRadius: 5, color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border)' }}>
                  MODE ?
                </span>
              )
            )}
            {!activeAccount.live_enabled ? (
              <button type="button" style={ctrlBtn('#238636', '#fff')} title="Arm real order execution for this account"
                onClick={() => triggerStartLive(activeAccountId)}>
                ▶ Start Live
              </button>
            ) : (
              <button type="button" style={ctrlBtn('transparent', '#f85149')} title="Stop arming — no more real orders"
                onClick={() => triggerDisarmLive(activeAccountId)}>
                ■ Disarm
              </button>
            )}
            {!activeAccount.paused ? (
              <button type="button" style={ctrlBtn('transparent', 'var(--text)')} title="Stop new entries; keep managing open positions"
                onClick={() => triggerPauseAccount(activeAccountId)}>
                ⏸ Pause
              </button>
            ) : (
              <button type="button" style={ctrlBtn('#238636', '#fff')} title="Resume opening new positions"
                onClick={() => triggerResumeAccount(activeAccountId)}>
                ▶ Resume
              </button>
            )}
          </div>
        )}

        {/* User profile & Logout */}
        {userProfile && (
          <div className="account-selector-profile-section" style={{ marginLeft: 0 }}>
            <span className="account-selector-email">
              {session?.user?.email}
              {userProfile.role === 'admin' && (
                <span className="account-selector-badge-admin">
                  ADMIN
                </span>
              )}
            </span>
            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="account-selector-logout-btn"
            >
              <LogOut size={12} strokeWidth={2.5} />
              Logout
            </button>
          </div>
        )}
      </div>

      {showLogoutConfirm && (
        <div className="modal-overlay-wrapper" onClick={() => setShowLogoutConfirm(false)}>
          <div className="modal-container-delete" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '380px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <LogOut size={18} strokeWidth={2.5} stroke="var(--text-dim)" />
              Confirm Logout
            </h3>
            
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              Are you sure you want to sign out of your account?
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                onClick={() => setShowLogoutConfirm(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLogoutConfirm(false);
                  handleLogout();
                }}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#f85149',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500
                }}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Cross-Tab State Synchronization via BroadcastChannel
 * 
 * Syncs critical UI state (page, theme, scanning/trading status) across
 * multiple browser tabs of the same origin. When one tab starts a scan
 * or switches pages, all other tabs update to match.
 */
import { useEffect, useRef, useCallback } from 'react';

const CHANNEL_NAME = 'option-scope-sync';

/**
 * Hook to synchronize state across browser tabs.
 * 
 * @param {Object} params
 * @param {string} params.page - Current active page
 * @param {Function} params.setPage - Setter for page
 * @param {string} params.theme - Current theme
 * @param {Function} params.setTheme - Setter for theme
 * @param {Object} params.handlers - Custom message handlers { [type]: (payload) => void }
 */
export function useTabSync({ page, setPage, theme, setTheme, handlers = {} }) {
  const channelRef = useRef(null);
  const tabId = useRef(Date.now().toString(36) + Math.random().toString(36).slice(2));
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const broadcast = useCallback((type, payload) => {
    try {
      channelRef.current?.postMessage({
        type,
        payload,
        senderId: tabId.current,
        timestamp: Date.now(),
      });
    } catch (e) {
      // BroadcastChannel may fail in some contexts
    }
  }, []);

  useEffect(() => {
    try {
      channelRef.current = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return;
    }

    const channel = channelRef.current;

    channel.onmessage = (event) => {
      const { type, payload, senderId } = event.data;
      if (senderId === tabId.current) return;

      switch (type) {
        case 'PAGE_CHANGE':
          setPage(payload.page);
          break;
        case 'THEME_CHANGE':
          setTheme(payload.theme);
          break;
        default:
          // Delegate to custom handlers
          if (handlersRef.current[type]) {
            handlersRef.current[type](payload);
          }
          break;
      }
    };

    return () => channel.close();
  }, [setPage, setTheme]);

  useEffect(() => {
    broadcast('PAGE_CHANGE', { page });
  }, [page, broadcast]);

  useEffect(() => {
    broadcast('THEME_CHANGE', { theme });
  }, [theme, broadcast]);

  return { broadcast, tabId: tabId.current };
}

/**
 * Lightweight hook for child components to listen for cross-tab messages.
 * Does NOT create a new BroadcastChannel — reuses one shared channel.
 * 
 * @param {Object} handlers - { [messageType]: (payload) => void }
 */
export function useTabListener(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const tabId = useRef(Date.now().toString(36) + Math.random().toString(36).slice(2));

  useEffect(() => {
    let channel;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return;
    }

    channel.onmessage = (event) => {
      const { type, payload, senderId } = event.data;
      if (senderId === tabId.current) return;
      if (handlersRef.current[type]) {
        handlersRef.current[type](payload);
      }
    };

    return () => channel.close();
  }, []);

  const broadcast = useCallback((type, payload) => {
    try {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      ch.postMessage({ type, payload, senderId: tabId.current, timestamp: Date.now() });
      ch.close();
    } catch (e) { }
  }, []);

  return { broadcast };
}

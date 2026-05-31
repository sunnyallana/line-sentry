import { useEffect, useRef } from 'react';
import socketService, { type SocketEventMap } from '../services/socket';

/**
 * Subscribe to a typed Socket.IO event with automatic, leak-free cleanup.
 * The handler may change between renders without re-subscribing, and the exact
 * callback is removed on unmount (fixing the bug where `off(event)` nuked every
 * component's listener for that event).
 */
export function useSocketEvent<E extends keyof SocketEventMap>(
  event: E,
  handler: (data: SocketEventMap[E]) => void,
  enabled = true,
): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const cb = (data: SocketEventMap[E]) => ref.current(data);
    socketService.on(event as string, cb);
    return () => socketService.off(event as string, cb);
  }, [event, enabled]);
}

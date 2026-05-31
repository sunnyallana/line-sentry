import { io, Socket } from 'socket.io-client';

// Socket server URL. When VITE_SOCKET_URL is set (e.g. http://localhost:3001 in
// local dev) we connect there; when empty we connect same-origin, which is how
// production runs behind nginx (it proxies /socket.io to the backend).
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || '';

/** Typed payloads for the realtime events the backend emits. */
export interface SocketEventMap {
  'power-signal': { machineId: string; value: number; timestamp: string };
  'machine-state-update': {
    machineId: string;
    status: string;
    color: string;
    hasPower: boolean;
    hasCycle: boolean;
    dbStatus: string;
    timestamp: string;
  };
  'production-update': {
    machineId: string;
    hour: number;
    date: string;
    unitsProduced: number;
    status: string;
    runningMinutes: number;
    stoppageMinutes: number;
    timestamp: string;
  };
  'running-time-update': {
    machineId: string;
    hour: number;
    date: string;
    runningMinutes: number;
    timestamp: string;
  };
  'unclassified-stoppage-detected': {
    machineId: string;
    hour: number;
    date: string;
    stoppageStart: string;
    pendingStoppageId: string;
    timestamp: string;
  };
  'stoppage-resolved': { machineId: string; timestamp: string };
  'stoppage-updated': {
    machineId: string;
    hour: number;
    date: string;
    stoppageId: string;
    duration: number;
  };
  'stoppage-added': { machineId: string; hour: number; date: string; stoppage: unknown; timestamp: string };
  'production-assignment-updated': {
    machineId: string;
    hours: number[];
    date: string;
    operatorId: string | null;
    moldId: string | null;
    originalHour: number;
    defectiveUnits?: number;
    timestamp: string;
  };
}

class SocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Function[]> = new Map();

  connect() {
    if (this.socket?.connected) return;

    const opts = { transports: ['websocket', 'polling'] as string[] };
    this.socket = SOCKET_URL ? io(SOCKET_URL, opts) : io(opts);

    this.socket.on('connect', () => {
      console.log('Connected to server');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    // Re-register all listeners
    this.listeners.forEach((callbacks, event) => {
      callbacks.forEach(callback => {
        this.socket?.on(event, callback as any);
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);

    // Attach whenever a socket exists (handlers may be registered before the
    // 'connect' event fires; socket.io attaches them correctly either way).
    if (this.socket) {
      this.socket.on(event, callback as any);
    }
  }

  off(event: string, callback?: Function) {
    if (callback) {
      const callbacks = this.listeners.get(event) || [];
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
      if (this.socket) {
        this.socket.off(event, callback as any);
      }
    } else {
      this.listeners.delete(event);
      if (this.socket) {
        this.socket.off(event);
      }
    }
  }

  joinMachine(machineId: string) {
    if (this.socket?.connected) {
      this.socket.emit('join-machine', machineId);
    }
  }

  leaveMachine(machineId: string) {
    if (this.socket?.connected) {
      this.socket.emit('leave-machine', machineId);
    }
  }

  emit(event: string, data: any) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    }
  }
}

export default new SocketService();
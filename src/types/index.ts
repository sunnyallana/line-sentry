export interface User {
  _id?: string;
  id?: string;
  username: string;
  email: string;
  role: 'admin' | 'operator';
  department?: Department;
}

export interface Department {
  _id: string;
  name: string;
  description?: string;
  layout?: Record<string, unknown>;
  machines?: Machine[];
  machineCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  avgOEE?: number;
}

export type MachineStatus = 'running' | 'stoppage' | 'stopped_yet_producing' | 'inactive';

export interface Machine {
  _id: string;
  name: string;
  description?: string;
  departmentId: string | Department;
  position: { x: number; y: number };
  dimensions: {
    width: number;
    height: number;
  };
  status: MachineStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Sensor {
  _id: string;
  name: string;
  description?: string;
  machineId: string | Machine;
  sensorType: 'power' | 'unit-cycle';
  isActive: boolean;
}

export interface ProductionTimelineDay {
  date: string;
  hours: ProductionHour[];
}

export interface ProductionHour {
  hour: number;
  unitsProduced: number;
  defectiveUnits: number;
  status: string;
  operator?: User;
  mold?: Mold;
  stoppages: StoppageRecord[];
  runningMinutes?: number;
  stoppageMinutes?: number;
}

export interface StoppageRecord {
  _id: string;
  reason: 'planned' | 'mold_change' | 'breakdown' | 'maintenance' | 'material_shortage' | 'other' | 'unclassified';
  description?: string;
  startTime: string | null;
  endTime?: string | null;
  duration?: number;
  reportedBy?: User;
}

export interface Mold {
  _id: string;
  name: string;
  description?: string;
  productionCapacityPerHour: number;
  departmentId: string | { _id: string; name: string };
  isActive: boolean;
}

export interface MachineStats {
  totalUnitsProduced: number;
  totalDefectiveUnits: number;
  oee: number;
  mtbf: number;
  mttr: number;
  availability: number;
  quality: number;
  performance: number;
  currentStatus: string;
  totalRunningMinutes?: number;
  totalStoppageMinutes?: number;
}

export interface Config {
  _id?: string;
  plc: {
    ip: string;
    rack: number;
    slot: number;
  };
  signalTimeouts: {
    powerSignalTimeout: number;
    cycleSignalTimeout: number;
  };
  shifts?: Array<{
    name: string;
    startTime: string;
    endTime: string;
    isActive: boolean;
  }>;
  email: {
    senderEmail: string;
    senderPassword: string;
    recipients: string[];
  };
  metricsThresholds: {
    oee: {
      excellent: number;
      good: number;
      fair: number;
    };
    availability: {
      excellent: number;
      good: number;
      fair: number;
    };
    quality: {
      excellent: number;
      good: number;
      fair: number;
    };
    performance: {
      excellent: number;
      good: number;
      fair: number;
    };
    mtbf: {
      excellent: number;
      good: number;
      fair: number;
    };
    mttr: {
      excellent: number;
      good: number;
      fair: number;
    };
    reliability: {
      excellent: number;
      good: number;
      fair: number;
    }
  };
}

export type MetricKey = 'oee' | 'availability' | 'quality' | 'performance' | 'mtbf' | 'mttr' | 'reliability';

export type LevelKey = 'excellent' | 'good' | 'fair';
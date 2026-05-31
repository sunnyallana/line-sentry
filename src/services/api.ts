import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

class ApiService {
  private axiosInstance: AxiosInstance;
  private token: string | null = null;

  constructor() {
    this.token = localStorage.getItem('token');
    
    // Create axios instance with security configurations
    this.axiosInstance = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      withCredentials: true, // Include cookies for CSRF protection
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest', // CSRF protection
      }
    });

    // Request interceptor to add auth token
    this.axiosInstance.interceptors.request.use(
      (config) => {
        if (this.token) {
          config.headers.Authorization = `Bearer ${this.token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    // this.axiosInstance.interceptors.response.use(
    //   (response) => response,
    //   (error) => {
    //     if (error.response?.status === 401) {
    //       this.clearToken();
    //       window.location.href = '/login';
    //     }
    //     return Promise.reject(error);
    //   }
    // );
  }

  setToken(token: string) {
    this.token = token;
    localStorage.setItem('token', token);
  }

  clearToken() {
    this.token = null;
    localStorage.removeItem('token');
  }

  async request(endpoint: string, options: AxiosRequestConfig = {}) {
    try {
      const response = await this.axiosInstance({
        url: endpoint,
        ...options
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(error.response?.data?.message || error.message || 'Network error');
      }
      throw new Error(error instanceof Error ? error.message : 'Network error');
    }
  }

  // Auth
  async login(username: string, password: string, captchaToken?: string) {
    const response = await this.request('/auth/login', {
      method: 'POST',
      data: { username, password, captchaToken },
    });
    this.setToken(response.token);
    return response;
  }

  async getCurrentOperator() {
    return this.request('/users/me/operator');
  }

  async getCurrentUser() {
    return this.request('/auth/me');
  }

  async initDemo() {
    return this.request('/auth/init-demo', { method: 'POST' });
  }

  // Departments
  async getDepartments(limit?: number) {
    return this.request('/departments', {
      method: 'GET',
      params: limit ? { limit } : undefined
    });
  }

  async getDepartment(id: string) {
    return this.request(`/departments/${id}`);
  }

  async getDepartmentsAdmin(params?: {
    page?: number;
    limit?: number;
    search?: string;
    isActive?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    return this.request('/departments/admin/all', {
      method: 'GET',
      params
    });
  }

  async createDepartment(department: Record<string, unknown>) {
    return this.request('/departments', {
      method: 'POST',
      data: department,
    });
  }

  async updateDepartment(id: string, department: Record<string, unknown>) {
    return this.request(`/departments/${id}`, {
      method: 'PUT',
      data: department,
    });
  }

  async getAllDepartments() {
    return this.request('/departments/admin/all');
  }

  async deleteDepartment(id: string) {
    return this.request(`/departments/${id}`, {
      method: 'DELETE',
    });
  }

  async getDepartmentStats(departmentId: string) {
    return this.request(`/analytics/department-stats/${departmentId}`);
  }

  // Machines
  async getMachinesByDepartment(departmentId: string) {
    return this.request(`/machines/department/${departmentId}`);
  }

  async getMachine(id: string) {
    return this.request(`/machines/${id}`);
  }

  async getMachines() {
    return this.request('/machines');
  }

  // Plant-wide setup readiness (per machine: signals wired? mold available?).
  async getSetupStatus() {
    return this.request('/machines/setup-status');
  }

  // Per-machine signal wiring (a "signal" = sensor + PLC pin, in one step).
  async getMachineSignals(machineId: string) {
    return this.request(`/machines/${machineId}/signals`);
  }
  async createMachineSignal(machineId: string, body: { plcId?: string; pinId: string; role: string }) {
    return this.request(`/machines/${machineId}/signals`, { method: 'POST', data: body });
  }
  async deleteMachineSignal(machineId: string, sensorId: string) {
    return this.request(`/machines/${machineId}/signals/${sensorId}`, { method: 'DELETE' });
  }

  // PLC registry — the devices the daemon(s) read from.
  async getPlcs() {
    return this.request('/plcs');
  }
  async createPlc(body: Record<string, unknown>) {
    return this.request('/plcs', { method: 'POST', data: body });
  }
  async updatePlc(id: string, body: Record<string, unknown>) {
    return this.request(`/plcs/${id}`, { method: 'PUT', data: body });
  }
  async deletePlc(id: string) {
    return this.request(`/plcs/${id}`, { method: 'DELETE' });
  }

  async createMachine(machine: Record<string, unknown>) {
    return this.request('/machines', {
      method: 'POST',
      data: machine,
    });
  }

  async updateMachine(id: string, machineData: Record<string, unknown>) {
    return this.request(`/machines/${id}`, {
      method: 'PUT',
      data: machineData,
    });
  }

  async updateMachinePosition(
    id: string, 
    position: { x: number; y: number }, 
    dimensions: { width: number; height: number }
  ) {
    return this.request(`/machines/${id}/position`, {
      method: 'PATCH',
      data: { 
        x: position.x, 
        y: position.y,
        width: dimensions.width,
        height: dimensions.height
      },
    });
  }

  async deleteMachine(id: string) {
    return this.request(`/machines/${id}`, {
      method: 'DELETE',
    });
  }

  // Users
  async getUsers() {
    return this.request('/users');
  }
  
  async getUsersAdmin(params?: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
    department?: string;
    isActive?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    return this.request('/users/admin/all', {
      method: 'GET',
      params
    });
  }

  async createUser(user: Record<string, unknown>) {
    return this.request('/users', {
      method: 'POST',
      data: user,
    });
  }

  async updateUser(id: string, user: Record<string, unknown>) {
    return this.request(`/users/${id}`, {
      method: 'PUT',
      data: user,
    });
  }

  async deleteUser(id: string) {
    return this.request(`/users/${id}`, {
      method: 'DELETE',
    });
  }

  // Analytics
  async getProductionTimeline(machineId: string, params?: { 
    timeframe?: string;
    startDate?: string;
    endDate?: string;
  }) {
    return this.request(`/analytics/production-timeline/${machineId}`, {
      method: 'GET',
      params
    });
  }

  async getMachineStats(machineId: string, params?: { 
    startDate?: string; 
    endDate?: string 
  }) {
    return this.request(`/analytics/machine-stats/${machineId}`, {
      method: 'GET',
      params
    }); 
}

  async addStoppageRecord(stoppage: Record<string, unknown>) {
    return this.request('/analytics/stoppage', {
      method: 'POST',
      data: stoppage,
    });
  }

  async updateStoppageRecord(id: string, stoppage: Record<string, unknown>) {
    return this.request(`/analytics/stoppage/${id}`, {
      method: 'PUT',
      data: stoppage,
    });
  }

  async updateProductionAssignment(data: Record<string, unknown>) {
    return this.request('/analytics/production-assignment', {
      method: 'POST',
      data: data,
    });
  }

  // Configuration
  async getConfig() {
    return this.request('/config');
  }

  async getShifts() {
    return this.request('/config/shifts');
  }

  async updateConfig(config: Record<string, unknown>) {
    return this.request('/config', {
      method: 'PUT',
      data: config,
    });
  }

  // Sensors
  async getSensors() {
    return this.request('/sensors');
  }

  async getSensorsByMachine(machineId: string) {
    return this.request(`/sensors/machine/${machineId}`);
  }

  async getSensorsAdmin(params?: {
    page?: number;
    limit?: number;
    search?: string;
    department?: string;
    status?: string;
    sensorType?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    return this.request('/sensors/admin/all', {
      method: 'GET',
      params
    });
  }

  async createSensor(sensor: Record<string, unknown>) {
    return this.request('/sensors', {
      method: 'POST',
      data: sensor,
    });
  }

  async updateSensor(id: string, sensorData: Record<string, unknown>) {
    return this.request(`/sensors/${id}`, {
      method: 'PUT',
      data: sensorData,
    });
  }

  async deleteSensor(id: string) {
    return this.request(`/sensors/${id}`, {
      method: 'DELETE',
    });
  }

  // Pin mapping
  async deletePinMapping(id: string) {
    return this.request(`/sensors/pin-mapping/${id}`, {
      method: 'DELETE',
    });
  }

  async createPinMapping(mapping: Record<string, unknown>) {
    return this.request('/sensors/pin-mapping', {
      method: 'POST',
      data: mapping,
    });
  }

  async getPinMappings() {
    return this.request('/sensors/pin-mappings');
  }

  // Molds
  async getMolds() {
    return this.request('/molds');
  }

  async getMoldsAdmin(params?: {
    page?: number;
    limit?: number;
    search?: string;
    department?: string;
    isActive?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    return this.request('/molds/admin/all', {
      method: 'GET',
      params
    });
  }

  async createMold(mold: Record<string, unknown>) {
    return this.request('/molds', {
      method: 'POST',
      data: mold,
    });
  }

  async updateMold(id: string, moldData: Record<string, unknown>) {
    return this.request(`/molds/${id}`, {
      method: 'PUT',
      data: moldData,
    });
  }

  async deleteMold(id: string) {
    return this.request(`/molds/${id}`, {
      method: 'DELETE',
    });
  }

  async toggleMoldStatus(id: string) {
    return this.request(`/molds/${id}/status`, {
      method: 'PATCH',
    });
  }

  // Reports
  async getReports(filters?: Record<string, unknown>) {
    return this.request('/reports', {
      method: 'GET',
      params: filters
    });
  }

  async generateReport(reportData: Record<string, unknown>) {
    return this.request('/reports/generate', {
      method: 'POST',
      data: reportData,
    });
  }

  async emailReport(reportId: string) {
    return this.request(`/reports/${reportId}/email`, {
      method: 'POST',
    });
  }

  // Download PDF with proper handling
  async downloadReportPDF(reportId: string, reportType: string, startDate: string) {
    try {
      const response = await this.axiosInstance({
        url: `/reports/${reportId}/pdf`,
        method: 'GET',
        responseType: 'blob'
      });
      
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${reportType}-report-${startDate}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      return { success: true };
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.message : undefined;
      throw new Error(message || 'Failed to download PDF');
    }
  }

  // Factory
  async getFactoryStats() {
    return this.request('/analytics/factory-stats');
  }
}


export default new ApiService();
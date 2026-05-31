import React, { useState, useEffect, useCallback, useContext } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../context/AuthContext';
import { Sensor, Machine, Department } from '../types';
import apiService from '../services/api';
import {
  Cpu,
  Plus,
  Edit,
  Trash2,
  Power,
  PowerOff,
  Search,
  Loader,
  Activity,
  Thermometer,
  Gauge,
  Zap,
  RotateCcw,
  Building2,
  Filter,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { ThemeContext } from '../App';

interface PaginationData {
  currentPage: number;
  totalPages: number;
  totalSensors: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  nextPage: number | null;
  prevPage: number | null;
}

interface SensorsResponse {
  sensors: Sensor[];
  pagination: PaginationData;
  filters: {
    search: string;
    department: string;
    status: string;
    sensorType: string;
    sortBy: string;
    sortOrder: string;
  };
}

// Zod schema for sensor form validation
const sensorFormSchema = z.object({
  name: z.string()
    .min(1, "Name is required")
    .max(50, "Name cannot exceed 50 characters"),
  description: z.string()
    .max(200, "Description cannot exceed 200 characters")
    .optional(),
  machineId: z.string()
    .min(1, "Machine is required"),
  sensorType: z.enum(['power', 'unit-cycle', 'temperature', 'pressure', 'vibration']),
  isActive: z.boolean()
});

type SensorFormData = z.infer<typeof sensorFormSchema>;

const Sensors: React.FC = () => {
  const { isAdmin } = useAuth();
  const { isDarkMode } = useContext(ThemeContext);
  const [sensorsData, setSensorsData] = useState<SensorsResponse | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Theme classes
  const bgClass = isDarkMode ? 'bg-gray-900' : 'bg-gray-50';
  const cardBgClass = isDarkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorderClass = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const textClass = isDarkMode ? 'text-white' : 'text-gray-900';
  const textSecondaryClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  const inputBgClass = isDarkMode ? 'bg-gray-700' : 'bg-white';
  const inputBorderClass = isDarkMode ? 'border-gray-600' : 'border-gray-300';
  const tableHeaderClass = isDarkMode ? 'bg-gray-750' : 'bg-gray-50';
  const tableRowHoverClass = isDarkMode ? 'hover:bg-gray-750' : 'hover:bg-gray-50';
  const buttonPrimaryClass = isDarkMode 
    ? 'bg-blue-600 hover:bg-blue-700' 
    : 'bg-blue-600 hover:bg-blue-700';
  const buttonSecondaryClass = isDarkMode 
    ? 'border-gray-600 text-gray-300 hover:bg-gray-700' 
    : 'border-gray-300 text-gray-700 hover:bg-gray-50';
  const errorClass = isDarkMode ? 'text-red-400' : 'text-red-600';

  // Pagination and filtering states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sensorTypeFilter, setSensorTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');
  const [showFilters, setShowFilters] = useState(false);
  
  // Modal states
  const [showForm, setShowForm] = useState(false);
  const [editingSensor, setEditingSensor] = useState<Sensor | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);

  // Debounced search
  const [searchTimeout, setSearchTimeout] = useState<NodeJS.Timeout | null>(null);

  // React Hook Form
  const formMethods = useForm<SensorFormData>({
    resolver: zodResolver(sensorFormSchema),
    defaultValues: {
      name: '',
      description: '',
      machineId: '',
      sensorType: 'power',
      isActive: true
    }
  });

  // Reset form when modal opens/closes or when editing sensor changes
  useEffect(() => {
    if (showForm) {
      if (editingSensor) {
        const machine = editingSensor.machineId as Machine;
        const department = machine.departmentId as Department;
        
        formMethods.reset({
          name: editingSensor.name,
          description: editingSensor.description || '',
          machineId: machine._id,
          isActive: editingSensor.isActive,
          sensorType: editingSensor.sensorType as any
        });
        
        setDepartmentFilter(department._id);
      } else {
        formMethods.reset({
          name: '',
          description: '',
          machineId: '',
          sensorType: 'power',
          isActive: true
        });
        setDepartmentFilter('');
      }
    }
  }, [showForm, editingSensor]);

  const fetchData = useCallback(async (page = 1, search = '', department = '', status = '', sensorType = '') => {
    try {
      setLoading(true);
      
      const params = {
        page,
        limit: pageSize,
        sortBy,
        sortOrder,
        ...(search && { search }),
        ...(department && { department }),
        ...(status !== '' && { status }),
        ...(sensorType && { sensorType })
      };

      const [sensorsResponse, departmentsData] = await Promise.all([
        apiService.getSensorsAdmin(params),
        apiService.getDepartments()
      ]);
      
      setSensorsData(sensorsResponse);
      setDepartments(departmentsData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch data';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [pageSize, sortBy, sortOrder]);

  // Debounced search effect
  useEffect(() => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    const timeout = setTimeout(() => {
      if (searchTerm !== (sensorsData?.filters.search || '')) {
        fetchData(1, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
      }
    }, 500);

    setSearchTimeout(timeout);

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [searchTerm]);

  useEffect(() => {
    fetchData(1, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
  }, [fetchData, departmentFilter, statusFilter, sensorTypeFilter, sortBy, sortOrder]);

  const handlePageChange = (page: number) => {
    if (page >= 1 && sensorsData && page <= sensorsData.pagination.totalPages) {
      fetchData(page, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
    }
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setCurrentPage(1);
    fetchData(1, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
  };

  const clearFilters = () => {
    setSearchTerm('');
    setDepartmentFilter('');
    setStatusFilter('');
    setSensorTypeFilter('');
    setSortBy('createdAt');
    setSortOrder('desc');
    setCurrentPage(1);
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const handleSubmit = formMethods.handleSubmit(async (formData) => {
    try {
      if (editingSensor) {
        await apiService.updateSensor(editingSensor._id, formData);
        toast.success('Sensor updated successfully');
      } else {
        await apiService.createSensor(formData);
        toast.success('Sensor created successfully');
      }
      
      resetForm();
      fetchData(currentPage, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
    } catch (err) {
      let message = 'Failed to save sensor';
      
      if (err instanceof Error) {
        if (err.message.includes('E11000 duplicate key error')) {
          message = 'Sensor name must be unique';
        } else {
          message = err.message;
        }
      }
      
      toast.error(message);
    }
  });

  const handleEdit = (sensor: Sensor) => {
    setEditingSensor(sensor);
    setShowForm(true);
  };

  const handleToggleStatus = async (id: string, isActive: boolean) => {
    try {
      setStatusTogglingId(id);
      await apiService.updateSensor(id, { isActive: !isActive });
      toast.success(`Sensor ${!isActive ? 'activated' : 'deactivated'} successfully`);
      
      // Refresh the current page
      fetchData(currentPage, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update sensor status';
      toast.error(message);
    } finally {
      setStatusTogglingId(null);
    }
  };

  const handleDelete = async (sensorId: string) => {
    if (!confirm('Are you sure you want to delete this sensor?')) return;

    try {
      setDeletingId(sensorId);
      await apiService.deleteSensor(sensorId);
      toast.success('Sensor deleted successfully');
      
      // If we're on the last page and it becomes empty, go to previous page
      if (sensorsData && sensorsData.sensors.length === 1 && currentPage > 1) {
        fetchData(currentPage - 1, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
      } else {
        fetchData(currentPage, searchTerm, departmentFilter, statusFilter, sensorTypeFilter);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete sensor';
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingSensor(null);
    setDepartmentFilter('');
  };

  const getSensorIcon = (type: string) => {
    switch (type) {
      case 'power': return <Zap className="h-4 w-4" />;
      case 'unit-cycle': return <RotateCcw className="h-4 w-4" />;
      case 'temperature': return <Thermometer className="h-4 w-4" />;
      case 'pressure': return <Gauge className="h-4 w-4" />;
      case 'vibration': return <Activity className="h-4 w-4" />;
      default: return <Cpu className="h-4 w-4" />;
    }
  };

  const getSensorTypeColor = (type: string) => {
    switch (type) {
      case 'power': return isDarkMode ? 'bg-yellow-400/10 text-yellow-400' : 'bg-yellow-100 text-yellow-800';
      case 'unit-cycle': return isDarkMode ? 'bg-blue-400/10 text-blue-400' : 'bg-blue-100 text-blue-800';
      case 'temperature': return isDarkMode ? 'bg-red-400/10 text-red-400' : 'bg-red-100 text-red-800';
      case 'pressure': return isDarkMode ? 'bg-purple-400/10 text-purple-400' : 'bg-purple-100 text-purple-800';
      case 'vibration': return isDarkMode ? 'bg-green-400/10 text-green-400' : 'bg-green-100 text-green-800';
      default: return isDarkMode ? 'bg-gray-400/10 text-gray-400' : 'bg-gray-100 text-gray-800';
    }
  };

  const Pagination = ({ pagination }: { pagination: PaginationData }) => {
    if (pagination.totalPages <= 1) return null;

    const getPageNumbers = () => {
      const pages = [];
      const maxVisible = 5;
      let start = Math.max(1, pagination.currentPage - Math.floor(maxVisible / 2));
      let end = Math.min(pagination.totalPages, start + maxVisible - 1);
      
      if (end - start + 1 < maxVisible) {
        start = Math.max(1, end - maxVisible + 1);
      }

      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
      
      return pages;
    };

    const paginationBgClass = isDarkMode ? 'bg-gray-800' : 'bg-gray-50';
    const paginationBorderClass = isDarkMode ? 'border-gray-700' : 'border-gray-200';
    const paginationTextClass = isDarkMode ? 'text-gray-400' : 'text-gray-500';
    const paginationButtonClass = isDarkMode ? 'bg-gray-700 text-white' : 'bg-white text-gray-700';
    const paginationHoverClass = isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100';

    return (
      <div className={`flex items-center justify-between px-6 py-3 ${paginationBgClass} border-t ${paginationBorderClass}`}>
        <div className={`flex items-center text-sm ${paginationTextClass}`}>
          Showing {((pagination.currentPage - 1) * pagination.limit) + 1} to{' '}
          {Math.min(pagination.currentPage * pagination.limit, pagination.totalSensors)} of{' '}
          {pagination.totalSensors} results
        </div>
        
        <div className="flex items-center space-x-2">
          <select
            value={pageSize}
            onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            className={`px-2 py-1 ${paginationButtonClass} border ${inputBorderClass} rounded text-sm`}
          >
            <option value={5}>5 per page</option>
            <option value={10}>10 per page</option>
            <option value={20}>20 per page</option>
            <option value={50}>50 per page</option>
          </select>
          
          <button
            onClick={() => handlePageChange(pagination.currentPage - 1)}
            disabled={!pagination.hasPrevPage}
            className={`p-2 ${paginationTextClass} hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          
          {getPageNumbers().map(page => (
            <button
              key={page}
              onClick={() => handlePageChange(page)}
              className={`px-3 py-1 rounded text-sm ${
                page === pagination.currentPage
                  ? 'bg-blue-600 text-white'
                  : `${paginationButtonClass} ${paginationHoverClass} ${paginationTextClass}`
              }`}
            >
              {page}
            </button>
          ))}
          
          <button
            onClick={() => handlePageChange(pagination.currentPage + 1)}
            disabled={!pagination.hasNextPage}
            className={`p-2 ${paginationTextClass} hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  };

  if (!isAdmin) {
    return (
      <div className={`${isDarkMode ? 'bg-red-900/50 border-red-500' : 'bg-red-100 border-red-300'} border px-4 py-3 rounded-md`}>
        <div className="flex items-center">
          <div className="h-4 w-4 mr-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
            </svg>
          </div>
          <span className={textClass}>Access denied. Admin privileges required.</span>
        </div>
      </div>
    );
  }

  const sensors = sensorsData?.sensors || [];
  const pagination = sensorsData?.pagination;

  return (
    <div className={`space-y-6 ${bgClass} min-h-screen p-4`}>
      <ToastContainer
        position="top-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme={isDarkMode ? "dark" : "light"}
      />
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <Cpu className={`h-8 w-8 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
          <div>
            <h1 className={`text-2xl font-bold ${textClass}`}>Sensors</h1>
            <p className={textSecondaryClass}>Manage and configure your industrial sensors</p>
          </div>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative w-full sm:w-64">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search sensors..."
              className={`pl-10 pr-4 py-2 w-full ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
              value={searchTerm}
              onChange={handleSearch}
            />
            {loading && (
              <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                <Loader className="h-4 w-4 animate-spin text-gray-400" />
              </div>
            )}
          </div>
          
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center space-x-2 px-4 py-2 border rounded-md transition-colors ${
              showFilters 
                ? 'bg-blue-600 border-blue-600 text-white' 
                : `${buttonSecondaryClass}`
            }`}
          >
            <Filter className="h-4 w-4" />
            <span>Filters</span>
          </button>
          
          <button
            onClick={() => setShowForm(true)}
            className={`flex items-center space-x-2 px-4 py-2 ${buttonPrimaryClass} text-white rounded-md transition-colors whitespace-nowrap`}
          >
            <Plus className="h-5 w-5" />
            <span>New Sensor</span>
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className={`rounded-lg border p-4 ${cardBgClass} ${cardBorderClass}`}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>Department</label>
              <select
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">All Departments</option>
                {departments.map(dept => (
                  <option key={dept._id} value={dept._id}>{dept.name}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">All Status</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            
            <div>
              <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>Sensor Type</label>
              <select
                value={sensorTypeFilter}
                onChange={(e) => setSensorTypeFilter(e.target.value)}
                className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">All Types</option>
                <option value="power">Power</option>
                <option value="unit-cycle">Unit Cycle</option>
                <option value="temperature">Temperature</option>
                <option value="pressure">Pressure</option>
                <option value="vibration">Vibration</option>
              </select>
            </div>
            
            <div>
              <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>Sort By</label>
              <div className="flex space-x-2">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className={`flex-1 px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                >
                  <option value="name">Name</option>
                  <option value="createdAt">Created Date</option>
                </select>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className={`px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                >
                  <option value="asc">↑</option>
                  <option value="desc">↓</option>
                </select>
              </div>
            </div>
          </div>
          
          <div className="flex justify-end mt-4">
            <button
              onClick={clearFilters}
              className={`px-4 py-2 ${textSecondaryClass} hover:${textClass} text-sm`}
            >
              Clear Filters
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      {pagination && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${textSecondaryClass}`}>Total Sensors</p>
                <p className={`text-xl font-semibold ${textClass}`}>{pagination.totalSensors}</p>
              </div>
              <Cpu className={`h-8 w-8 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
            </div>
          </div>

          <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${textSecondaryClass}`}>Current Page</p>
                <p className={`text-xl font-semibold ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>
                  {pagination.currentPage} of {pagination.totalPages}
                </p>
              </div>
              <Power className={`h-8 w-8 ${isDarkMode ? 'text-green-400' : 'text-green-500'}`} />
            </div>
          </div>

          <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${textSecondaryClass}`}>Showing</p>
                <p className={`text-xl font-semibold ${isDarkMode ? 'text-yellow-400' : 'text-amber-600'}`}>
                  {sensors.length} sensors
                </p>
              </div>
              <Cpu className={`h-8 w-8 ${isDarkMode ? 'text-yellow-400' : 'text-amber-500'}`} />
            </div>
          </div>
        </div>
      )}

      {/* Sensor Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className={`rounded-lg border w-full max-w-md ${cardBgClass} ${cardBorderClass}`}>
            <div className={`p-6 border-b ${cardBorderClass}`}>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-semibold ${textClass}`}>
                  {editingSensor ? 'Edit Sensor' : 'Create New Sensor'}
                </h3>
                <button 
                  onClick={resetForm}
                  className={textSecondaryClass}
                >
                  &times;
                </button>
              </div>
            </div>
            
            <FormProvider {...formMethods}>
              <form onSubmit={handleSubmit} className="p-6 space-y-4">
                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Sensor Name *
                  </label>
                  <input
                    type="text"
                    className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    placeholder="Enter sensor name"
                    {...formMethods.register('name')}
                  />
                  {formMethods.formState.errors.name && (
                    <p className={`mt-1 text-sm ${errorClass}`}>
                      {formMethods.formState.errors.name.message}
                    </p>
                  )}
                </div>

                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Description
                  </label>
                  <textarea
                    rows={3}
                    className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    placeholder="Enter sensor description"
                    {...formMethods.register('description')}
                  />
                  {formMethods.formState.errors.description && (
                    <p className={`mt-1 text-sm ${errorClass}`}>
                      {formMethods.formState.errors.description.message}
                    </p>
                  )}
                </div>

                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Sensor Type *
                  </label>
                  <select
                    className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    {...formMethods.register('sensorType')}
                  >
                    <option value="power">Power Sensor</option>
                    <option value="unit-cycle">Unit Cycle Sensor</option>
                    <option value="temperature">Temperature Sensor</option>
                    <option value="pressure">Pressure Sensor</option>
                    <option value="vibration">Vibration Sensor</option>
                  </select>
                </div>

                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Department *
                  </label>
                  <select
                    value={departmentFilter}
                    onChange={(e) => {
                      setDepartmentFilter(e.target.value);
                      formMethods.setValue('machineId', '');
                    }}
                    className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  >
                    <option value="">Select department</option>
                    {departments.map((dept) => (
                      <option key={dept._id} value={dept._id}>
                        {dept.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Machine *
                  </label>
                  <select
                    className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    disabled={!departmentFilter}
                    {...formMethods.register('machineId')}
                  >
                    <option value="">Select machine</option>
                    {departments
                      .find(d => d._id === departmentFilter)
                      ?.machines?.map((machine) => (
                        <option key={machine._id} value={machine._id}>
                          {machine.name}
                        </option>
                      )) || []}
                  </select>
                  {formMethods.formState.errors.machineId && (
                    <p className={`mt-1 text-sm ${errorClass}`}>
                      {formMethods.formState.errors.machineId.message}
                    </p>
                  )}
                </div>

                <div>
                  <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                    Active Status
                  </label>
                  <div className="flex items-center">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        {...formMethods.register('isActive')}
                      />
                      <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                      <span className={`ml-3 text-sm ${textSecondaryClass}`}>
                        {formMethods.watch('isActive') ? 'Active' : 'Inactive'}
                      </span>
                    </label>
                  </div>
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={resetForm}
                    className={`px-4 py-2 border ${buttonSecondaryClass} rounded-md`}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`px-4 py-2 ${buttonPrimaryClass} text-white rounded-md`}
                  >
                    {editingSensor ? 'Update Sensor' : 'Create Sensor'}
                  </button>
                </div>
              </form>
            </FormProvider>
          </div>
        </div>
      )}

      {/* Sensors Table */}
      <div className={`rounded-lg border overflow-hidden ${cardBgClass} ${cardBorderClass}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className={tableHeaderClass}>
              <tr>
                <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Sensor
                </th>
                <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Machine
                </th>
                <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Department
                </th>
                <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Type
                </th>
                <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Status
                </th>
                <th scope="col" className={`px-6 py-3 text-right text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDarkMode ? 'divide-gray-700' : 'divide-gray-200'}`}>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center">
                    <div className="flex justify-center">
                      <Loader className="h-6 w-6 animate-spin text-blue-500" />
                    </div>
                  </td>
                </tr>
              ) : sensors.length > 0 ? (
                sensors.map((sensor) => {
                  const machine = (sensor.machineId as Machine);
                  const department = (machine.departmentId as Department);
                  
                  return (
                    <tr 
                      key={sensor._id} 
                      className={`${tableRowHoverClass} ${!sensor.isActive ? 'opacity-70' : ''}`}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className={`flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center ${getSensorTypeColor(sensor.sensorType)}`}>
                            {getSensorIcon(sensor.sensorType)}
                          </div>
                          <div className="ml-4">
                            <div className={`text-sm font-medium ${textClass}`}>
                              {sensor.name}
                            </div>
                            <div className={`text-xs ${textSecondaryClass} truncate max-w-xs`}>
                              {sensor.description || 'No description'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`text-sm ${textClass}`}>
                          {machine?.name || 'Unknown'}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`text-sm ${textClass} flex items-center`}>
                          <Building2 className={`h-4 w-4 mr-1 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
                          {department?.name || 'Unknown'}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full capitalize ${getSensorTypeColor(sensor.sensorType)}`}>
                          {sensor.sensorType.replace('-', ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          sensor.isActive 
                            ? isDarkMode ? 'bg-green-900/50 text-green-400' : 'bg-green-100 text-green-800'
                            : isDarkMode ? 'bg-red-900/50 text-red-400' : 'bg-red-100 text-red-800'
                        }`}>
                          {sensor.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end space-x-2">
                          <button
                            onClick={() => handleEdit(sensor)}
                            className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                              isDarkMode 
                                ? 'text-blue-400 hover:text-blue-300' 
                                : 'text-blue-600 hover:text-blue-800'
                            }`}
                            title="Edit"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(sensor._id, sensor.isActive)}
                            disabled={statusTogglingId === sensor._id}
                            className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                              statusTogglingId === sensor._id ? 'opacity-50' : ''
                            } ${
                              sensor.isActive 
                                ? isDarkMode 
                                  ? 'text-yellow-400 hover:text-yellow-300' 
                                  : 'text-amber-600 hover:text-amber-800'
                                : isDarkMode 
                                  ? 'text-green-400 hover:text-green-300' 
                                  : 'text-green-600 hover:text-green-800'
                            }`}
                            title={sensor.isActive ? 'Deactivate' : 'Activate'}
                          >
                            {statusTogglingId === sensor._id ? (
                              <Loader className="h-4 w-4 animate-spin" />
                            ) : sensor.isActive ? (
                              <PowerOff className="h-4 w-4" />
                            ) : (
                              <Power className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() => handleDelete(sensor._id)}
                            disabled={deletingId === sensor._id}
                            className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                              deletingId === sensor._id ? 'opacity-50' : ''
                            } ${
                              isDarkMode 
                                ? 'text-red-400 hover:text-red-300' 
                                : 'text-red-600 hover:text-red-800'
                            }`}
                            title="Delete"
                          >
                            {deletingId === sensor._id ? (
                              <Loader className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center">
                      <Cpu className={`h-12 w-12 ${textSecondaryClass} mb-4`} />
                      <h3 className={`text-lg font-medium ${textSecondaryClass} mb-2`}>No sensors found</h3>
                      <p className={textSecondaryClass}>
                        {searchTerm || departmentFilter || statusFilter !== '' || sensorTypeFilter !== ''
                          ? 'No sensors match your current filters' 
                          : 'Get started by creating your first sensor'}
                      </p>
                      <button 
                        onClick={() => setShowForm(true)}
                        className={`mt-4 px-4 py-2 ${buttonPrimaryClass} text-white rounded-md`}
                      >
                        Create Sensor
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination */}
        {pagination && !loading && <Pagination pagination={pagination} />}
      </div>
    </div>
  );
};

export default Sensors;
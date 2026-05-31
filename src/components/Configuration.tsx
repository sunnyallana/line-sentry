import React, { useState, useEffect, useContext } from 'react';
import { useForm, FormProvider, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../context/AuthContext';
import { ThemeContext } from '../App';
import { Config, Sensor, MetricKey, LevelKey } from '../types';
import apiService from '../services/api';
import {
  Settings,
  Network,
  Mail,
  Save,
  Cpu,
  Link,
  Plus,
  Trash2,
  Clock,
  BarChart2
} from 'lucide-react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Zod schemas
const plcSchema = z.object({
  ip: z.string().min(1, "IP is required"),
  rack: z.number().int().min(0, "Rack must be non-negative"),
  slot: z.number().int().min(0, "Slot must be non-negative")
});

const emailSchema = z.object({
  senderEmail: z.email("Invalid email format"),
  senderPassword: z.string().min(1, "Password is required"),
  recipients: z.array(z.email("Invalid email format")).min(1, "At least one recipient is required")
});

const signalTimeoutsSchema = z.object({
  powerSignalTimeout: z.number().int().min(1).max(60),
  cycleSignalTimeout: z.number().int().min(1).max(60)
});

const shiftSchema = z.object({
  name: z.string().min(1, "Name is required"),
  startTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, "Invalid time format (HH:MM)"),
  endTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, "Invalid time format (HH:MM)"),
  isActive: z.boolean()
});

const levelThresholdsSchema = z.object({
  excellent: z.number().min(0, "Value must be non-negative"),
  good: z.number().min(0, "Value must be non-negative"),
  fair: z.number().min(0, "Value must be non-negative")
});

const metricsThresholdsSchema = z.object({
  oee: levelThresholdsSchema,
  availability: levelThresholdsSchema,
  quality: levelThresholdsSchema,
  performance: levelThresholdsSchema,
  mtbf: levelThresholdsSchema,
  mttr: levelThresholdsSchema,
  reliability: levelThresholdsSchema
});

const configSchema = z.object({
  plc: plcSchema,
  email: emailSchema,
  signalTimeouts: signalTimeoutsSchema,
  shifts: z.array(shiftSchema),
  metricsThresholds: metricsThresholdsSchema
});

type ConfigFormData = z.infer<typeof configSchema>;

const Configuration: React.FC = () => {
  const { isAdmin } = useAuth();
  const { isDarkMode } = useContext(ThemeContext);
  const [config, setConfig] = useState<Config | null>(null);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [pinMappings, setPinMappings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('plc');

  // Pin mapping state
  const [selectedSensor, setSelectedSensor] = useState('');
  const [selectedPin, setSelectedPin] = useState('');

  const methods = useForm<ConfigFormData>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      plc: { ip: '', rack: 0, slot: 1 },
      email: { senderEmail: '', senderPassword: '', recipients: [''] },
      signalTimeouts: { powerSignalTimeout: 5, cycleSignalTimeout: 2 },
      shifts: [],
      metricsThresholds: {
        oee: { excellent: 85, good: 70, fair: 50 },
        availability: { excellent: 90, good: 80, fair: 70 },
        quality: { excellent: 95, good: 90, fair: 85 },
        performance: { excellent: 90, good: 80, fair: 70 },
        mtbf: { excellent: 500, good: 300, fair: 150 },
        mttr: { excellent: 20, good: 40, fair: 60 },
        reliability: { excellent: 10, good: 5, fair: 2 }
      }
    }
  });

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = methods;

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'shifts'
  });

  useEffect(() => {
    if (isAdmin) {
      fetchConfigData();
    }
  }, [isAdmin]);

  const fetchConfigData = async () => {
    try {
      const [configData, sensorsData, pinMappingsData] = await Promise.all([
        apiService.getConfig(),
        apiService.getSensors(),
        apiService.getPinMappings()
      ]);

      // Ensure all required fields exist
      if (!configData.metricsThresholds) {
        configData.metricsThresholds = {
          oee: { excellent: 85, good: 70, fair: 50},
          availability: { excellent: 90, good: 80, fair: 70},
          quality: { excellent: 95, good: 90, fair: 85},
          performance: { excellent: 90, good: 80, fair: 70},
          mtbf: { excellent: 500, good: 300, fair: 150},
          mttr: { excellent: 20, good: 40, fair: 60},
          reliability: {excellent: 10, good: 5, fair: 2}
        };
      }

      if (!configData.signalTimeouts) {
        configData.signalTimeouts = {
          powerSignalTimeout: 5,
          cycleSignalTimeout: 2
        };
      }
      
      setConfig(configData);
      setSensors(sensorsData);
      setPinMappings(pinMappingsData);
      
      // Reset form with fetched data
      reset({
        plc: configData.plc,
        email: {
          ...configData.email,
          recipients: configData.email.recipients
        },
        signalTimeouts: configData.signalTimeouts,
        shifts: configData.shifts || [],
        metricsThresholds: configData.metricsThresholds
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch configuration';
      toast.error(errorMessage, {
        position: "top-right",
        autoClose: 5000,
        theme: "dark"
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfigUpdate = async (data: Partial<Config>) => {
    setSaving(true);

    try {
      const newConfig = { ...config, ...data } as Config;
      await apiService.updateConfig(newConfig);
      setConfig(newConfig);
      toast.success('Configuration updated successfully', {
        position: "top-right",
        autoClose: 3000,
        theme: "dark"
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update configuration';
      toast.error(errorMessage, {
        position: "top-right",
        autoClose: 5000,
        theme: "dark"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMapping = async (mappingId: string) => {
    if (confirm('Are you sure you want to permanently delete this pin mapping?')) {
      try {
        await apiService.deletePinMapping(mappingId);
        toast.success('Pin mapping deleted successfully', {
          position: "top-right",
          autoClose: 3000,
          theme: "dark"
        });
        fetchConfigData(); // Refresh data
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to delete pin mapping';
        toast.error(errorMessage, {
          position: "top-right",
          autoClose: 5000,
          theme: "dark"
        });
      }
    }
  };

  const handlePinMapping = async () => {
    if (!selectedSensor || !selectedPin) return;

    try {
      await apiService.createPinMapping({
        sensorId: selectedSensor,
        pinId: selectedPin
      });
      
      toast.success('Pin mapping created successfully', {
        position: "top-right",
        autoClose: 3000,
        theme: "dark"
      });
      
      setSelectedSensor('');
      setSelectedPin('');
      fetchConfigData(); // Refresh data
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create pin mapping';
      toast.error(errorMessage, {
        position: "top-right",
        autoClose: 5000,
        theme: "dark"
      });
    }
  };

  const availablePins = Array.from({ length: 8 }, (_, i) => `DQ.${i}`);
  const occupiedPins = pinMappings.map(mapping => mapping.pinId);
  const availablePinsForSelection = availablePins.filter(pin => !occupiedPins.includes(pin));

  if (!isAdmin) {
    return (
      <div className={`border px-4 py-3 rounded-md ${
        isDarkMode 
          ? 'bg-red-900/50 border-red-500 text-red-300'
          : 'bg-red-50 border-red-200 text-red-700'
      }`}>
        <div className="flex items-center">
          <span>Access denied. Admin privileges required.</span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const onSubmit = (data: ConfigFormData) => {
    // Handle each tab's save separately
    switch (activeTab) {
      case 'plc':
        handleConfigUpdate({ plc: data.plc });
        break;
      case 'email':
        handleConfigUpdate({ email: data.email });
        break;
      case 'signals':
        handleConfigUpdate({ signalTimeouts: data.signalTimeouts });
        break;
      case 'shifts':
        handleConfigUpdate({ shifts: data.shifts });
        break;
      case 'thresholds':
        handleConfigUpdate({ metricsThresholds: data.metricsThresholds });
        break;
      default:
        break;
    }
  };

  return (
    <FormProvider {...methods}>
      <div className={`space-y-6 ${isDarkMode ? '' : 'min-h-screen bg-gray-50'}`}>
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
        <div className="flex items-center space-x-4 px-4 sm:px-0">
          <Settings className="h-8 w-8 text-blue-400" />
          <div>
            <h1 className={`text-2xl font-bold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>System Configuration</h1>
            <p className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>Configure PLC settings, email alerts, and sensor mappings</p>
          </div>
        </div>

        {/* Tabs */}
        <div className={`border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'} pb-1 px-2 sm:px-0`}>
          <nav className="-mb-px flex space-x-1 md:space-x-3 overflow-x-auto scrollbar-thin 
            ${isDarkMode ? 'scrollbar-thumb-gray-600 scrollbar-track-gray-800' : 'scrollbar-thumb-gray-300 scrollbar-track-gray-100'} 
            whitespace-nowrap pb-1`}">
            {[
              { id: 'plc', label: 'PLC', icon: Cpu, fullLabel: 'PLC Configuration' },
              { id: 'email', label: 'Email', icon: Mail, fullLabel: 'Email Settings' },
              { id: 'signals', label: 'Signals', icon: Settings, fullLabel: 'Signal Settings' },
              { id: 'shifts', label: 'Shifts', icon: Clock, fullLabel: 'Shift Management' },
              { id: 'mapping', label: 'Mapping', icon: Link, fullLabel: 'Pin Mapping' },
              { id: 'thresholds', label: 'Thresholds', icon: BarChart2, fullLabel: 'Metrics Thresholds' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-1 py-2 px-2 md:px-3 border-b-2 font-medium text-xs md:text-sm transition-all ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : `border-transparent ${isDarkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
                }`}
                aria-label={tab.fullLabel}
              >
                <tab.icon className="h-4 w-4 flex-shrink-0" />
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.label.charAt(0)}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="space-y-6 px-2 sm:px-4">
          
          {/* PLC Configuration */}
          {activeTab === 'plc' && (
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className={`rounded-lg border p-4 sm:p-6 ${
                isDarkMode 
                  ? 'bg-gray-800 border-gray-700' 
                  : 'bg-white border-gray-200 shadow-sm'
              }`}>
                <div className="flex items-center space-x-2 mb-4">
                  <Network className="h-5 w-5 text-blue-400" />
                  <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>PLC Connection Settings</h2>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      IP Address
                    </label>
                    <Controller
                      name="plc.ip"
                      control={control}
                      render={({ field }) => (
                        <>
                          <input
                            {...field}
                            type="text"
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.plc?.ip ? 'border-red-500' : ''}`}
                            placeholder="192.168.1.100"
                          />
                          {errors.plc?.ip && (
                            <p className="text-red-500 text-xs mt-1">{errors.plc.ip.message}</p>
                          )}
                        </>
                      )}
                    />
                  </div>
                  
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Rack
                    </label>
                    <Controller
                      name="plc.rack"
                      control={control}
                      render={({ field }) => (
                        <>
                          <input
                            {...field}
                            type="number"
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.plc?.rack ? 'border-red-500' : ''}`}
                            placeholder="0"
                          />
                          {errors.plc?.rack && (
                            <p className="text-red-500 text-xs mt-1">{errors.plc.rack.message}</p>
                          )}
                        </>
                      )}
                    />
                  </div>
                  
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Slot
                    </label>
                    <Controller
                      name="plc.slot"
                      control={control}
                      render={({ field }) => (
                        <>
                          <input
                            {...field}
                            type="number"
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 1)}
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.plc?.slot ? 'border-red-500' : ''}`}
                            placeholder="1"
                          />
                          {errors.plc?.slot && (
                            <p className="text-red-500 text-xs mt-1">{errors.plc.slot.message}</p>
                          )}
                        </>
                      )}
                    />
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? 'Saving...' : 'Save PLC Settings'}</span>
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Email Configuration */}
          {activeTab === 'email' && (
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className={`rounded-lg border p-4 sm:p-6 ${
                isDarkMode 
                  ? 'bg-gray-800 border-gray-700' 
                  : 'bg-white border-gray-200 shadow-sm'
              }`}>
                <div className="flex items-center space-x-2 mb-4">
                  <Mail className="h-5 w-5 text-blue-400" />
                  <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Outlook Email Alert Settings</h2>
                </div>
                
                <div className="space-y-4">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div>
                      <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        Sender Email
                      </label>
                      <Controller
                        name="email.senderEmail"
                        control={control}
                        render={({ field }) => (
                          <>
                            <input
                              {...field}
                              type="email"
                              className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                isDarkMode 
                                  ? 'bg-gray-700 border-gray-600 text-white' 
                                  : 'bg-white border-gray-300 text-gray-900'
                              } ${errors.email?.senderEmail ? 'border-red-500' : ''}`}
                              placeholder="alerts@company.com"
                            />
                            {errors.email?.senderEmail && (
                              <p className="text-red-500 text-xs mt-1">{errors.email.senderEmail.message}</p>
                            )}
                          </>
                        )}
                      />
                    </div>
                    
                    <div>
                      <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        App Password
                      </label>
                      <Controller
                        name="email.senderPassword"
                        control={control}
                        render={({ field }) => (
                          <>
                            <input
                              {...field}
                              type="password"
                              className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                isDarkMode 
                                  ? 'bg-gray-700 border-gray-600 text-white' 
                                  : 'bg-white border-gray-300 text-gray-900'
                              } ${errors.email?.senderPassword ? 'border-red-500' : ''}`}
                              placeholder="App-specific password"
                            />
                            {errors.email?.senderPassword && (
                              <p className="text-red-500 text-xs mt-1">{errors.email.senderPassword.message}</p>
                            )}
                          </>
                        )}
                      />
                    </div>
                  </div>

                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Recipients (comma-separated)
                    </label>
                    <Controller
                      name="email.recipients"
                      control={control}
                      render={({ field: { value, onChange } }) => (
                        <>
                          <textarea
                            value={value.join(', ')}
                            onChange={(e) => {
                              const recipients = e.target.value
                                .split(',')
                                .map(email => email.trim())
                                .filter(Boolean);
                              onChange(recipients);
                            }}
                            rows={3}
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.email?.recipients ? 'border-red-500' : ''}`}
                            placeholder="manager@company.com, operator@company.com"
                          />
                          {errors.email?.recipients && (
                            <p className="text-red-500 text-xs mt-1">
                              {errors.email.recipients.message || 
                               errors.email.recipients[0]?.message}
                            </p>
                          )}
                        </>
                      )}
                    />
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? 'Saving...' : 'Save Email Settings'}</span>
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Signal Settings Tab */}
          {activeTab === 'signals' && (
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className={`rounded-lg border p-4 sm:p-6 ${
                isDarkMode 
                  ? 'bg-gray-800 border-gray-700' 
                  : 'bg-white border-gray-200 shadow-sm'
              }`}>
                <div className="flex items-center space-x-2 mb-4">
                  <Settings className="h-5 w-5 text-blue-400" />
                  <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Signal Timeout Settings</h2>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Power Signal Timeout (minutes)
                    </label>
                    <Controller
                      name="signalTimeouts.powerSignalTimeout"
                      control={control}
                      render={({ field }) => (
                        <>
                          <input
                            {...field}
                            type="number"
                            min="1"
                            max="60"
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 5)}
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.signalTimeouts?.powerSignalTimeout ? 'border-red-500' : ''}`}
                          />
                          {errors.signalTimeouts?.powerSignalTimeout && (
                            <p className="text-red-500 text-xs mt-1">
                              {errors.signalTimeouts.powerSignalTimeout.message}
                            </p>
                          )}
                        </>
                      )}
                    />
                    <p className={`text-xs mt-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      Time after which machine is considered inactive if no power signal
                    </p>
                  </div>
                  
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Cycle Signal Timeout (minutes)
                    </label>
                    <Controller
                      name="signalTimeouts.cycleSignalTimeout"
                      control={control}
                      render={({ field }) => (
                        <>
                          <input
                            {...field}
                            type="number"
                            min="1"
                            max="60"
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 2)}
                            className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              isDarkMode 
                                ? 'bg-gray-700 border-gray-600 text-white' 
                                : 'bg-white border-gray-300 text-gray-900'
                            } ${errors.signalTimeouts?.cycleSignalTimeout ? 'border-red-500' : ''}`}
                          />
                          {errors.signalTimeouts?.cycleSignalTimeout && (
                            <p className="text-red-500 text-xs mt-1">
                              {errors.signalTimeouts.cycleSignalTimeout.message}
                            </p>
                          )}
                        </>
                      )}
                    />
                    <p className={`text-xs mt-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      Time after which unclassified stoppage is detected if no cycle signal
                    </p>
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? 'Saving...' : 'Save Signal Settings'}</span>
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Shift Management Tab */}
          {activeTab === 'shifts' && (
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="space-y-6">
                <div className={`rounded-lg border p-4 sm:p-6 ${
                  isDarkMode 
                    ? 'bg-gray-800 border-gray-700' 
                    : 'bg-white border-gray-200 shadow-sm'
                }`}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center space-x-2">
                      <Clock className="h-5 w-5 text-blue-400" />
                      <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Shift Management</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => append({
                        name: `Shift ${fields.length + 1}`,
                        startTime: '08:00',
                        endTime: '16:00',
                        isActive: true
                      })}
                      className="flex items-center space-x-2 px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                      <span>Add Shift</span>
                    </button>
                  </div>

                  {fields.length > 0 ? (
                    <div className="space-y-4">
                      {fields.map((field, index) => (
                        <div key={field.id} className={`rounded-lg p-4 ${
                          isDarkMode ? 'bg-gray-700' : 'bg-gray-50'
                        }`}>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                            <div>
                              <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                                Shift Name
                              </label>
                              <Controller
                                name={`shifts.${index}.name`}
                                control={control}
                                render={({ field }) => (
                                  <>
                                    <input
                                      {...field}
                                      className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                        isDarkMode 
                                          ? 'bg-gray-600 border-gray-500 text-white' 
                                          : 'bg-white border-gray-300 text-gray-900'
                                      } ${errors.shifts?.[index]?.name ? 'border-red-500' : ''}`}
                                    />
                                    {errors.shifts?.[index]?.name && (
                                      <p className="text-red-500 text-xs mt-1">
                                        {errors.shifts[index]?.name?.message}
                                      </p>
                                    )}
                                  </>
                                )}
                              />
                            </div>
                            
                            <div>
                              <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                                Start Time
                              </label>
                              <Controller
                                name={`shifts.${index}.startTime`}
                                control={control}
                                render={({ field }) => (
                                  <>
                                    <input
                                      {...field}
                                      type="time"
                                      className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                        isDarkMode 
                                          ? 'bg-gray-600 border-gray-500 text-white' 
                                          : 'bg-white border-gray-300 text-gray-900'
                                      } ${errors.shifts?.[index]?.startTime ? 'border-red-500' : ''}`}
                                    />
                                    {errors.shifts?.[index]?.startTime && (
                                      <p className="text-red-500 text-xs mt-1">
                                        {errors.shifts[index]?.startTime?.message}
                                      </p>
                                    )}
                                  </>
                                )}
                              />
                            </div>
                            
                            <div>
                              <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                                End Time
                              </label>
                              <Controller
                                name={`shifts.${index}.endTime`}
                                control={control}
                                render={({ field }) => (
                                  <>
                                    <input
                                      {...field}
                                      type="time"
                                      className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                        isDarkMode 
                                          ? 'bg-gray-600 border-gray-500 text-white' 
                                          : 'bg-white border-gray-300 text-gray-900'
                                      } ${errors.shifts?.[index]?.endTime ? 'border-red-500' : ''}`}
                                    />
                                    {errors.shifts?.[index]?.endTime && (
                                      <p className="text-red-500 text-xs mt-1">
                                        {errors.shifts[index]?.endTime?.message}
                                      </p>
                                    )}
                                  </>
                                )}
                              />
                            </div>
                            
                            <div className="flex items-center space-x-2">
                              <div className="flex items-center">
                                <Controller
                                  name={`shifts.${index}.isActive`}
                                  control={control}
                                  render={({ field }) => (
                                    <label className="relative inline-flex items-center cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={field.value}
                                        onChange={(e) => field.onChange(e.target.checked)}
                                        className="sr-only peer"
                                      />
                                      <div className={`relative w-11 h-6 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 ${
                                        isDarkMode ? 'bg-gray-600' : 'bg-gray-300'
                                      }`}></div>
                                      <span className={`ml-2 text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>Active</span>
                                    </label>
                                  )}
                                />
                              </div>
                              
                              <button
                                type="button"
                                onClick={() => remove(index)}
                                className={`p-1 ${isDarkMode ? 'text-red-400 hover:text-red-300' : 'text-red-500 hover:text-red-700'}`}
                                title="Delete shift"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <Clock className={`h-12 w-12 mx-auto mb-4 ${isDarkMode ? 'text-gray-600' : 'text-gray-400'}`} />
                      <p className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>No shifts configured</p>
                      <p className={`text-sm mt-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>Add your first shift to get started</p>
                    </div>
                  )}

                  <div className="mt-6">
                    <button
                      type="submit"
                      disabled={saving}
                      className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      <Save className="h-4 w-4" />
                      <span>{saving ? 'Saving...' : 'Save Shifts'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </form>
          )}

          {/* Pin Mapping */}
          {activeTab === 'mapping' && (
          <div className="space-y-6">
            {/* Add New Mapping */}
            <div className={`rounded-lg border p-4 sm:p-6 ${
              isDarkMode 
                ? 'bg-gray-800 border-gray-700' 
                : 'bg-white border-gray-200 shadow-sm'
            }`}>
              <div className="flex items-center space-x-2 mb-4">
                <Plus className="h-5 w-5 text-blue-400" />
                <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Create Pin Mapping</h2>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div>
                  <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    Sensor
                  </label>
                  <select
                    value={selectedSensor}
                    onChange={(e) => setSelectedSensor(e.target.value)}
                    className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode 
                        ? 'bg-gray-700 border-gray-600 text-white' 
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  >
                    <option value="">Select sensor...</option>
                    {sensors.filter(sensor => 
                      !pinMappings.some(mapping => mapping.sensorId._id === sensor._id)
                    ).map((sensor) => (
                      <option key={sensor._id} value={sensor._id}>
                        {sensor.name} ({sensor.sensorType})
                      </option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    PLC Pin
                  </label>
                  <select
                    value={selectedPin}
                    onChange={(e) => setSelectedPin(e.target.value)}
                    className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode 
                        ? 'bg-gray-700 border-gray-600 text-white' 
                        : 'bg-white border-gray-300 text-gray-900'
                    }`}
                  >
                    <option value="">Select pin...</option>
                    {availablePinsForSelection.map((pin) => (
                      <option key={pin} value={pin}>
                        {pin}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-end">
                  <button
                    onClick={handlePinMapping}
                    disabled={!selectedSensor || !selectedPin}
                    className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    <Link className="h-4 w-4" />
                    <span>Map Pin</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Current Mappings */}
            <div className={`rounded-lg border p-4 sm:p-6 ${
              isDarkMode 
                ? 'bg-gray-800 border-gray-700' 
                : 'bg-white border-gray-200 shadow-sm'
            }`}>
              <h2 className={`text-lg font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Current Pin Mappings</h2>
              
              {pinMappings.length > 0 ? (
                <div className="space-y-3">
                  {pinMappings.map((mapping) => (
                    <div key={mapping._id} className={`rounded-lg p-4 flex items-center justify-between ${
                      isDarkMode ? 'bg-gray-700' : 'bg-gray-50'
                    }`}>
                      <div className="flex items-center space-x-4">
                        <div className="bg-blue-600 text-white px-3 py-1 rounded text-sm font-mono">
                          {mapping.pinId}
                        </div>
                        <div>
                          <div className={`font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{mapping.sensorId.name}</div>
                          <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                            {mapping.sensorId.sensorType} • Machine: {mapping.sensorId.machineId?.name || 'Unknown'}
                          </div>
                        </div>
                      </div>
                      <div className="flex space-x-2">
                        <button 
                          onClick={() => handleDeleteMapping(mapping._id)}
                          className={`p-2 rounded ${
                            isDarkMode 
                              ? 'text-red-400 hover:bg-red-400/10' 
                              : 'text-red-500 hover:bg-red-50'
                          }`}
                          title="Delete permanently"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>No pin mappings configured</p>
                  <p className={`text-sm mt-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>Create your first mapping above</p>
                </div>
              )}
            </div>

            {/* Pin Status Overview */}
            {activeTab === 'mapping' && (
              <div className={`rounded-lg border p-4 sm:p-6 ${
                isDarkMode 
                  ? 'bg-gray-800 border-gray-700' 
                  : 'bg-white border-gray-200 shadow-sm'
              }`}>
                <h2 className={`text-lg font-semibold mb-4 ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>PLC Pin Status</h2>
                
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                  {availablePins.map((pin) => {
                    const mapping = pinMappings.find(m => m.pinId === pin);
                    let statusClass = isDarkMode 
                      ? 'bg-gray-700 border-gray-600 text-gray-400'
                      : 'bg-gray-100 border-gray-300 text-gray-600';
                    let statusText = 'Free';
                    
                    if (mapping) {
                      statusClass = isDarkMode
                        ? 'bg-green-900/50 border-green-500 text-green-300'
                        : 'bg-green-100 border-green-400 text-green-700';
                      statusText = 'Mapped';
                    }
                    
                    return (
                      <div
                        key={pin}
                        className={`p-3 rounded-lg border text-center ${statusClass}`}
                        title={mapping ? `Mapped to: ${mapping.sensorId.name}` : 'Available'}
                      >
                        <div className="font-mono text-sm">{pin}</div>
                        <div className="text-xs mt-1">
                          {statusText}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
           )}


          {/* Metrics Thresholds Tab */}
          {activeTab === 'thresholds' && (
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className={`rounded-lg border p-4 sm:p-6 ${
                isDarkMode 
                  ? 'bg-gray-800 border-gray-700' 
                  : 'bg-white border-gray-200 shadow-sm'
              }`}>
                <div className="flex items-center space-x-2 mb-4">
                  <BarChart2 className="h-5 w-5 text-blue-400" />
                  <h2 className={`text-lg font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                    Performance Metric Thresholds
                  </h2>
                </div>
                
                <div className="space-y-5">
                  {(['oee', 'availability', 'quality', 'performance', 'mtbf', 'mttr', 'reliability'] as MetricKey[]).map(metric => {
                    const unit = ['oee', 'availability', 'quality', 'performance'].includes(metric) 
                      ? '%' 
                      : 'min';
                    
                    return (
                      <div 
                        key={metric}
                        className={`rounded-lg p-4 border ${
                          isDarkMode 
                            ? 'bg-gray-750 border-gray-600' 
                            : 'bg-gray-50 border-gray-200'
                        }`}
                      >
                        <h3 className={`text-md font-medium mb-3 flex items-center ${
                          isDarkMode ? 'text-blue-300' : 'text-blue-600'
                        }`}>
                          <span className="capitalize">{metric}</span>
                          <span className="ml-2 text-xs px-2 py-1 rounded ${
                            isDarkMode 
                              ? 'bg-blue-900/30 text-blue-200' 
                              : 'bg-blue-100 text-blue-700'
                          }">
                            {unit}
                          </span>
                        </h3>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {(['excellent', 'good', 'fair'] as LevelKey[]).map((level, idx) => {
                            // Border colors for visual distinction
                            const borderColors = [
                              isDarkMode ? 'border-green-500' : 'border-green-400',
                              isDarkMode ? 'border-yellow-500' : 'border-yellow-400',
                              isDarkMode ? 'border-orange-500' : 'border-orange-400'
                            ];
                            
                            return (
                              <div 
                                key={`${metric}-${level}`} 
                                className={`border-l-4 rounded-r p-3 ${
                                  borderColors[idx]
                                } ${
                                  isDarkMode 
                                    ? 'bg-gray-700' 
                                    : 'bg-white'
                                }`}
                              >
                                <label className={`block text-sm font-medium mb-1 ${
                                  isDarkMode ? 'text-gray-300' : 'text-gray-700'
                                }`}>
                                  <span className="capitalize">{level}</span>
                                  <span className="text-xs ml-1 ${
                                    isDarkMode ? 'text-gray-400' : 'text-gray-500'
                                  }">
                                    ({level === 'excellent' ? '≥' : level === 'good' ? '≥' : level === 'fair'  ? '≥' : '<'})
                                  </span>
                                </label>
                                <div className="flex">
                                  <Controller
                                    name={`metricsThresholds.${metric}.${level}`}
                                    control={control}
                                    render={({ field }) => (
                                      <>
                                        <input
                                          {...field}
                                          type="number"
                                          onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                                          className={`w-full rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                            isDarkMode 
                                              ? 'bg-gray-600 border-gray-500 text-white' 
                                              : 'bg-white border-gray-300 text-gray-900'
                                          } ${errors.metricsThresholds?.[metric]?.[level] ? 'border-red-500' : ''}`}
                                        />
                                        {errors.metricsThresholds?.[metric]?.[level] && (
                                          <p className="text-red-500 text-xs mt-1">
                                            {errors.metricsThresholds[metric]?.[level]?.message}
                                          </p>
                                        )}
                                      </>
                                    )}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        
                        <div className={`text-xs mt-3 ${
                          isDarkMode ? 'text-gray-400' : 'text-gray-600'
                        }`}>
                          {metric === 'mttr' && "Mean Time To Repair (lower is better)"}
                          {metric === 'mtbf' && "Mean Time Between Failures (higher is better)"}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-6">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? 'Saving...' : 'Save Thresholds'}</span>
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </FormProvider>
  );
};

export default Configuration;
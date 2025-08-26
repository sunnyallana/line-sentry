import React, { useEffect, useState, useRef, useMemo, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Department, Machine, MachineStats, MachineStatus } from '../types';
import apiService from '../services/api';
import { useAuth } from '../context/AuthContext';
import socketService from '../services/socket';
import { ThemeContext } from '../App';

import {
  ArrowLeft,
  Settings,
  Activity,
  Plus,
  Edit,
  Power,
  Gauge,
  Trash2,
  Save,
  X,
  AlertTriangle
} from 'lucide-react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const DepartmentView: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { isDarkMode } = useContext(ThemeContext);
  const [department, setDepartment] = useState<Department | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddingMachine, setIsAddingMachine] = useState(false);
  const [newMachine, setNewMachine] = useState<{
    name: string;
    description: string;
  }>({
    name: '',
    description: '',
  });
  const [editLayoutMode, setEditLayoutMode] = useState(false);
  const [positions, setPositions] = useState<{[key: string]: {x: number; y: number}}>({});
  const [dimensions, setDimensions] = useState<{[key: string]: {width: number; height: number}}>({});
  const [draggingMachineId, setDraggingMachineId] = useState<string | null>(null);
  const [resizingMachineId, setResizingMachineId] = useState<string | null>(null);
  const [machineStatuses, setMachineStatuses] = useState<{[key: string]: string}>({});
  const layoutContainerRef = useRef<HTMLDivElement>(null);
  const [machineStats, setMachineStats] = useState<{[machineId: string]: MachineStats}>({});
  const [bgImageExists, setBgImageExists] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeInitial = useRef({ width: 0, height: 0, x: 0, y: 0 });
  const machinesRef = useRef<Machine[]>([]);
  machinesRef.current = machines;

  // Theme classes
  const bgClass = isDarkMode ? 'bg-gray-900' : 'bg-gray-50';
  const cardBgClass = isDarkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorderClass = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const textClass = isDarkMode ? 'text-white' : 'text-gray-900';
  const textSecondaryClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  const inputBgClass = isDarkMode ? 'bg-gray-700' : 'bg-white';
  const inputBorderClass = isDarkMode ? 'border-gray-600' : 'border-gray-300';
  const buttonPrimaryClass = isDarkMode 
    ? 'bg-blue-600 hover:bg-blue-700' 
    : 'bg-blue-600 hover:bg-blue-500';
  const buttonSecondaryClass = isDarkMode 
    ? 'border-gray-600 text-gray-300 hover:bg-gray-700' 
    : 'border-gray-300 text-gray-700 hover:bg-gray-100';

  // Calculate department stats from machine data
  const departmentStats = useMemo(() => {
    let totalUnits = 0;
    let totalOEE = 0;
    let runningMachines = 0;
    let stoppedMachines = 0;
    let machinesWithStats = 0;

    machines.forEach(machine => {
      // Count machine states
      if (machine.status === 'running') {
        runningMachines++;
      } else {
        stoppedMachines++;
      }

      // Aggregate stats if available
      if (machineStats[machine._id]) {
        const stats = machineStats[machine._id];
        totalUnits += stats.totalUnitsProduced || 0;
        totalOEE += stats.oee || 0;
        machinesWithStats++;
      }
    });

    // Calculate average OEE
    const avgOEE = machinesWithStats > 0 
      ? Math.round(totalOEE / machinesWithStats) 
      : 0;

    return {
      totalUnits,
      avgOEE,
      runningMachines,
      stoppedMachines
    };
  }, [machines, machineStats]);

  const toSnakeCase = (str: string) => {
    return str.toLowerCase().replace(/\s+/g, '_');
  };

  useEffect(() => {
    if (department) {
      const img = new Image();
      const imageName = toSnakeCase(department.name);
      img.src = `/${imageName}.png`;
      img.onload = () => setBgImageExists(true);
      img.onerror = () => setBgImageExists(false);
    }
  }, [department]);


  useEffect(() => {
    if (id) {
      fetchDepartmentData();
      setupSocketListeners();
    }
    
    return () => {
      socketService.off('machine-state-update');
      socketService.off('production-update');
      socketService.off('stoppage-added');
      socketService.off('unclassified-stoppage-detected');
    };
  }, [id]);

  const setupSocketListeners = () => {
    const handleMachineStateUpdate = (update: any) => {
      const machine = machinesRef.current.find(m => m._id === update.machineId);
      if (machine) {
        setMachineStatuses(prev => ({
          ...prev,
          [update.machineId]: update.status
        }));
        
        setMachines(prevMachines => 
          prevMachines.map(m => 
            m._id === update.machineId 
              ? { ...m, status: update.dbStatus }
              : m
          )
        );
      }
    };

    const handleProductionUpdate = (update: any) => {
      const machine = machinesRef.current.find(m => m._id === update.machineId);
      if (machine) {
        fetchMachineStatsForMachine(update.machineId);
      }
    };

    const handleStoppageUpdate = (update: any) => {
      const machine = machinesRef.current.find(m => m._id === update.machineId);
      if (machine) {
        fetchMachineStatsForMachine(update.machineId);
      }
    };

    socketService.on('machine-state-update', handleMachineStateUpdate);
    socketService.on('production-update', handleProductionUpdate);
    socketService.on('stoppage-added', handleStoppageUpdate);
    socketService.on('unclassified-stoppage-detected', handleStoppageUpdate);

    return () => {
      socketService.off('machine-state-update', handleMachineStateUpdate);
      socketService.off('production-update', handleProductionUpdate);
      socketService.off('stoppage-added', handleStoppageUpdate);
      socketService.off('unclassified-stoppage-detected', handleStoppageUpdate);
    };
  };

  const fetchDepartmentData = async () => {
    try {
      setLoading(true);
      const deptData = await apiService.getDepartment(id!);
      setDepartment(deptData);
      setMachines(deptData.machines || []);
      
      const initialPositions: {[key: string]: {x: number; y: number}} = {};
      const initialDimensions: {[key: string]: {width: number; height: number}} = {};
      
      deptData.machines?.forEach((machine: Machine) => {
        initialPositions[machine._id] = { ...machine.position };
        initialDimensions[machine._id] = { 
          width: machine.dimensions?.width || 154, 
          height: machine.dimensions?.height || 152 
        };
      });

      setPositions(initialPositions);
      setDimensions(initialDimensions);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch department data';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const fetchMachineStatsForMachine = async (machineId: string) => {
    try {
      // Calculate YTD date range
      const now = new Date();
      const startDate = new Date(now.getFullYear(), 0, 1); // January 1st of current year
      const endDate = now;

      const stats = await apiService.getMachineStats(machineId, { 
        startDate: startDate.toISOString(), 
        endDate: endDate.toISOString() 
      });
      
      setMachineStats(prev => ({
        ...prev,
        [machineId]: stats
      }));
    } catch (error) {
      console.error(`Failed to fetch YTD stats for machine ${machineId}:`, error);
    }
  };

  const fetchMachineStats = async () => {
    try {
      const stats: {[machineId: string]: MachineStats} = {};
      
      // Calculate YTD date range once
      const now = new Date();
      const startDate = new Date(now.getFullYear(), 0, 1); // January 1st
      const startDateStr = startDate.toISOString();
      const endDateStr = now.toISOString();

      // Fetch stats for all machines in parallel
      const statsPromises = machines.map(machine => 
        apiService.getMachineStats(machine._id, { 
          startDate: startDateStr, 
          endDate: endDateStr 
        })
          .then(machineStats => ({ machineId: machine._id, machineStats }))
          .catch(error => {
            console.error(`Failed to fetch YTD stats for machine ${machine._id}:`, error);
            return null;
          })
      );

      const results = await Promise.all(statsPromises);
      
      // Aggregate results
      results.forEach(result => {
        if (result) {
          stats[result.machineId] = result.machineStats;
        }
      });

      setMachineStats(stats);
    } catch (error) {
      console.error('Failed to fetch YTD machine stats:', error);
    }
  };

  useEffect(() => {
    if (machines.length > 0) {
      fetchMachineStats();
    }
  }, [machines]);

  const handleMachineClick = (machineId: string) => {
    if (!editLayoutMode) {
      navigate(`/machine/${machineId}`);
    }
  };

  const getStatusColor = (status: MachineStatus) => {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'stoppage': return 'bg-red-500 animate-pulse';
      case 'stopped_yet_producing': return 'bg-orange-500';
      case 'inactive': return 'bg-gray-500';
      default: return 'bg-gray-500';
    }
  };

  const getStatusText = (status: MachineStatus) => {
    switch (status) {
      case 'running': return 'Running';
      case 'stoppage': return 'Stoppage';
      case 'stopped_yet_producing': return 'Stopped Yet Producing';
      case 'inactive': return 'Inactive';
      default: return status;
    }
  };

  const handleAddMachine = async () => {
    try {
      const createdMachine = await apiService.createMachine({
        ...newMachine,
        departmentId: id
      });
      
      setMachines([...machines, createdMachine]);
      setPositions({
        ...positions,
        [createdMachine._id]: createdMachine.position
      });
      setDimensions({
        ...dimensions,
        [createdMachine._id]: { 
          width: createdMachine.dimensions?.width || 154, 
          height: createdMachine.dimensions?.height || 152 
        }
      });
      setIsAddingMachine(false);
      setNewMachine({
        name: '',
        description: '',
      });
      toast.success('Machine added successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add machine';
      toast.error(message);
    }
  };

  const handleDeleteMachine = async (machineId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to permanently delete this machine? All associated data will be lost.')) {
      try {
        await apiService.deleteMachine(machineId);
        setMachines(machines.filter(m => m._id !== machineId));
        
        // Remove from positions and dimensions to prevent errors
        const newPositions = { ...positions };
        delete newPositions[machineId];
        setPositions(newPositions);
        
        const newDimensions = { ...dimensions };
        delete newDimensions[machineId];
        setDimensions(newDimensions);
        
        if (draggingMachineId === machineId) {
          setDraggingMachineId(null);
        }
        if (resizingMachineId === machineId) {
          setResizingMachineId(null);
        }
        toast.success('Machine deleted successfully');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete machine';
        toast.error(message);
      }
    }
  };

  const handleMouseDown = (machineId: string, e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    e.stopPropagation();
    
    const containerRect = layoutContainerRef.current.getBoundingClientRect();
    const machineX = positions[machineId]?.x || 0;
    const machineY = positions[machineId]?.y || 0;
    
    dragOffset.current = {
      x: e.clientX - containerRect.left - machineX,
      y: e.clientY - containerRect.top - machineY
    };
    
    setDraggingMachineId(machineId);
  };

  const handleResizeMouseDown = (machineId: string, e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    e.stopPropagation();
    
    setResizingMachineId(machineId);
    resizeInitial.current = {
      width: dimensions[machineId]?.width || 154,
      height: dimensions[machineId]?.height || 152,
      x: e.clientX,
      y: e.clientY
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    
    // Handle dragging
    if (draggingMachineId) {
      const containerRect = layoutContainerRef.current.getBoundingClientRect();
      const x = e.clientX - containerRect.left - dragOffset.current.x;
      const y = e.clientY - containerRect.top - dragOffset.current.y;
      
      const boundedX = Math.max(10, Math.min(x, containerRect.width - (dimensions[draggingMachineId]?.width || 154)));
      const boundedY = Math.max(10, Math.min(y, containerRect.height - (dimensions[draggingMachineId]?.height || 152)));
      
      setPositions(prev => ({
        ...prev,
        [draggingMachineId]: { x: boundedX, y: boundedY }
      }));
    }
    
    // Handle resizing
    if (resizingMachineId) {
      const deltaX = e.clientX - resizeInitial.current.x;
      const deltaY = e.clientY - resizeInitial.current.y;
      
      // Allow resizing down to 50x50
      const newWidth = Math.max(50, resizeInitial.current.width + deltaX);
      const newHeight = Math.max(50, resizeInitial.current.height + deltaY);
      
      setDimensions(prev => ({
        ...prev,
        [resizingMachineId]: {
          width: newWidth,
          height: newHeight
        }
      }));
    }
  };

  const handleMouseUp = async () => {
    if (!editLayoutMode) return;
    
    // Handle dragging save
    if (draggingMachineId) {
      if (!machines.some(m => m._id === draggingMachineId)) {
        setDraggingMachineId(null);
        return;
      }

      try {
        await apiService.updateMachinePosition(
          draggingMachineId, 
          positions[draggingMachineId],
          dimensions[draggingMachineId]
        );
        toast.success('Machine position updated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update machine position';
        toast.error(message);
      } finally {
        setDraggingMachineId(null);
      }
    }
    
    // Handle resizing save
    if (resizingMachineId) {
      if (!machines.some(m => m._id === resizingMachineId)) {
        setResizingMachineId(null);
        return;
      }

      try {
        await apiService.updateMachinePosition(
          resizingMachineId, 
          positions[resizingMachineId],
          dimensions[resizingMachineId]
        );
        toast.success('Machine size updated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update machine size';
        toast.error(message);
      } finally {
        setResizingMachineId(null);
      }
    }
  };

  const handleSaveLayout = async () => {
    try {
      const validPositions = Object.keys(positions)
        .filter(machineId => machines.some(m => m._id === machineId))
        .reduce((acc, machineId) => {
          acc[machineId] = positions[machineId];
          return acc;
        }, {} as {[key: string]: {x: number; y: number}});
      
      const validDimensions = Object.keys(dimensions)
        .filter(machineId => machines.some(m => m._id === machineId))
        .reduce((acc, machineId) => {
          acc[machineId] = dimensions[machineId];
          return acc;
        }, {} as {[key: string]: {width: number; height: number}});

      await Promise.all(
        Object.entries(validPositions).map(([machineId, position]) => 
          apiService.updateMachinePosition(
            machineId, 
            position,
            validDimensions[machineId]
          )
        )
      );
      setEditLayoutMode(false);
      toast.success('Layout saved successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save layout';
      toast.error(message);
    }
  };

  if (loading) {
    return (
      <div className={`flex items-center justify-center h-64 ${bgClass}`}>
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!department) {
    return (
      <div className={`text-center py-12 ${bgClass}`}>
        <p className={textSecondaryClass}>Department not found</p>
      </div>
    );
  }

  return (
    <div className={`space-y-6 p-4 min-h-screen ${bgClass}`}>
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
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate('/dashboard')}
            className={`p-2 ${textSecondaryClass} hover:${textClass} hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-200'} rounded-md transition-colors`}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className={`text-2xl font-bold ${textClass}`}>{department.name}</h1>
            <p className={textSecondaryClass}>{department.description}</p>
          </div>
        </div>
        
        {isAdmin && (
          <div className="flex items-center space-x-2">
            <button 
              onClick={() => setIsAddingMachine(true)}
              className={`flex items-center space-x-2 px-4 py-2 ${buttonPrimaryClass} text-white rounded-md transition-colors`}
            >
              <Plus className="h-4 w-4" />
              <span>Add Machine</span>
            </button>
            <button 
              onClick={() => setEditLayoutMode(!editLayoutMode)}
              className={`p-2 ${textSecondaryClass} hover:${textClass} hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-200'} rounded-md transition-colors`}
            >
              {editLayoutMode ? <Save className="h-5 w-5" /> : <Settings className="h-5 w-5" />}
            </button>
          </div>
        )}
      </div>

      {/* Department Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm ${textSecondaryClass}`}>Total Machines</p>
              <p className={`text-xl font-semibold ${textClass}`}>{machines.length}</p>
            </div>
            <Activity className={`h-8 w-8 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
          </div>
        </div>

        <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm ${textSecondaryClass}`}>Running</p>
              <p className={`text-xl font-semibold ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>{departmentStats.runningMachines}</p>
            </div>
            <Power className={`h-8 w-8 ${isDarkMode ? 'text-green-400' : 'text-green-500'}`} />
          </div>
        </div>

        <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm ${textSecondaryClass}`}>Stopped</p>
              <p className={`text-xl font-semibold ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{departmentStats.stoppedMachines}</p>
            </div>
            <AlertTriangle className={`h-8 w-8 ${isDarkMode ? 'text-red-400' : 'text-red-500'}`} />
          </div>
        </div>

        <div className={`p-4 rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm ${textSecondaryClass}`}>Department OEE (YTD)</p>
              <p className={`text-xl font-semibold ${isDarkMode ? 'text-yellow-400' : 'text-amber-600'}`}>{departmentStats.avgOEE}%</p>
            </div>
            <Gauge className={`h-8 w-8 ${isDarkMode ? 'text-yellow-400' : 'text-amber-500'}`} />
          </div>
        </div>
      </div>

      {/* Machine Layout */}
      <div className={`rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
        <div className={`p-6 border-b ${cardBorderClass}`}>
          <div className="flex items-center justify-between">
            <h2 className={`text-lg font-semibold ${textClass}`}>Machine Layout</h2>
            {isAdmin && (
              <button 
                onClick={() => setEditLayoutMode(!editLayoutMode)}
                className={`${isDarkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-800'} text-sm flex items-center space-x-1`}
              >
                <Edit className="h-4 w-4" />
                <span>{editLayoutMode ? 'Save Layout' : 'Edit Layout'}</span>
              </button>
            )}
          </div>
        </div>

        <div className="p-6">
          {machines.length > 0 ? (
            <div 
              ref={layoutContainerRef}
              className={`relative w-full min-h-[700px] rounded-lg border border-dashed ${cardBorderClass} ${
                isDarkMode ? 'bg-gray-900/50' : 'bg-gray-100'
              }`}
              style={
                bgImageExists && department
                  ? {
                      backgroundImage: `url(/${toSnakeCase(department.name)}.png)`,
                      backgroundSize: 'contain',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat'
                    }
                  : {}
              }
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {machines.map((machine) => {
                const width = dimensions[machine._id]?.width || 154;
                const height = dimensions[machine._id]?.height || 152;
                const isSmall = width < 100 || height < 100;
                
                return (
                  <div
                    key={machine._id}
                    onClick={() => handleMachineClick(machine._id)}
                    className={`absolute rounded-lg border ${
                      editLayoutMode 
                        ? `${isDarkMode ? 'border-blue-500' : 'border-blue-600'} cursor-move` 
                        : `${cardBorderClass} ${isDarkMode ? 'hover:border-blue-500' : 'hover:border-blue-600'}`
                    } transition-all duration-200 ${
                      isDarkMode ? 'hover:shadow-lg hover:shadow-blue-500/10' : 'hover:shadow-md hover:shadow-blue-500/20'
                    }`}
                    style={{
                      left: `${positions[machine._id]?.x || 0}px`,
                      top: `${positions[machine._id]?.y || 0}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                      zIndex: (draggingMachineId === machine._id || resizingMachineId === machine._id) ? 10 : 1,
                      cursor: editLayoutMode ? 'move' : 'pointer',
                      transform: (draggingMachineId === machine._id || resizingMachineId === machine._id) ? 'scale(1.02)' : 'none',
                      transition: (draggingMachineId === machine._id || resizingMachineId === machine._id) ? 'none' : 'all 0.2s ease',
                      boxShadow: (draggingMachineId === machine._id || resizingMachineId === machine._id) 
                        ? isDarkMode 
                          ? '0 10px 25px rgba(0, 0, 0, 0.3)' 
                          : '0 10px 15px rgba(0, 0, 0, 0.1)'
                        : 'none',
                      backgroundColor: isDarkMode ? '#1f2937' : '#f9fafb',
                      padding: isSmall ? '0.25rem' : '0.75rem',
                      display: 'flex',
                      flexDirection: 'column'
                    }}
                    onMouseDown={(e) => handleMouseDown(machine._id, e)}
                  >
                    <div className="flex items-center justify-between w-full">
                      <h3 
                        className={`font-medium ${textClass} truncate`}
                        style={{
                          fontSize: isSmall ? '0.65rem' : '0.875rem',
                          maxWidth: isSmall ? `${width - 30}px` : '100%'
                        }}
                      >
                        {machine.name}
                      </h3>
                      <div className="flex items-center space-x-1">
                        <div 
                          className={`rounded-full ${getStatusColor(machineStatuses[machine._id] as MachineStatus || machine.status as MachineStatus)}`}
                          style={{
                            width: isSmall ? '0.5rem' : '0.75rem',
                            height: isSmall ? '0.5rem' : '0.75rem',
                            minWidth: isSmall ? '0.5rem' : '0.75rem'
                          }}
                        ></div>
                        {editLayoutMode && !isSmall && (
                          <button
                            onClick={(e) => handleDeleteMachine(machine._id, e)}
                            className={`p-1 rounded-md ${isDarkMode ? 'text-red-400 hover:text-red-300 hover:bg-gray-700' : 'text-red-600 hover:text-red-800 hover:bg-gray-100'}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between w-full mt-1">
                      <span 
                        className={`${textSecondaryClass} truncate`}
                        style={{ 
                          fontSize: isSmall ? '0.65rem' : '0.75rem',
                        }}
                      >
                        {machine.description || 'No description'}
                      </span>
                    </div>
                    
                    <div className="flex items-center justify-between w-full mt-1">
                      <span 
                        className={`font-medium ${
                          (machineStatuses[machine._id] || machine.status) === 'running' 
                            ? isDarkMode ? 'text-green-400' : 'text-green-600' :
                          (machineStatuses[machine._id] || machine.status) === 'stoppage' 
                            ? isDarkMode ? 'text-red-400' : 'text-red-600' :
                          (machineStatuses[machine._id] || machine.status) === 'stopped_yet_producing' 
                            ? isDarkMode ? 'text-orange-400' : 'text-orange-600' :
                          textSecondaryClass
                        }`}
                        style={{ fontSize: isSmall ? '0.65rem' : '0.75rem' }}
                      >
                        {getStatusText(machineStatuses[machine._id] as MachineStatus || machine.status as MachineStatus)}
                      </span>
                    </div>
                    
                    {!isSmall && (
                      <div className="space-y-1 mt-auto">
                        <div className="flex items-center justify-between w-full">
                          <span 
                            className={textSecondaryClass}
                            style={{ fontSize: '0.7rem' }}
                          >
                            OEE (YTD)
                          </span>
                          <span 
                            className={`font-medium ${textClass}`}
                            style={{ fontSize: '0.7rem' }}
                          >
                            {machineStats[machine._id]?.oee ?? 'N/A'}%
                          </span>
                        </div>

                        <div className="flex items-center justify-between w-full">
                          <span 
                            className={textSecondaryClass}
                            style={{ fontSize: '0.7rem' }}
                          >
                            Units
                          </span>
                          <span 
                            className={`font-medium ${textClass}`}
                            style={{ fontSize: '0.7rem' }}
                          >
                            {machineStats[machine._id]?.totalUnitsProduced ?? 'N/A'}
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {editLayoutMode && (
                      <div 
                        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
                        onMouseDown={(e) => handleResizeMouseDown(machine._id, e)}
                      >
                        <div 
                          className={`w-full h-full`}
                          style={{ 
                            borderBottom: `2px solid ${isDarkMode ? 'white' : 'black'}`,
                            borderRight: `2px solid ${isDarkMode ? 'white' : 'black'}`,
                            borderBottomRightRadius: '0.25rem'
                          }} 
                        />
                      </div>
                    )}
                    
                    {editLayoutMode && isSmall && (
                      <button
                        onClick={(e) => handleDeleteMachine(machine._id, e)}
                        className={`absolute top-0 right-0 p-1 rounded-md ${isDarkMode ? 'text-red-400 hover:text-red-300 hover:bg-gray-700' : 'text-red-600 hover:text-red-800 hover:bg-gray-100'}`}
                        style={{ zIndex: 20 }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Activity className={`h-12 w-12 mx-auto mb-4 ${textSecondaryClass}`} />
              <h3 className={`text-lg font-medium ${textSecondaryClass} mb-2`}>No machines found</h3>
              <p className={`${textSecondaryClass} mb-4`}>
                This department doesn't have any machines configured yet.
              </p>
              {isAdmin && (
                <button 
                  onClick={() => setIsAddingMachine(true)}
                  className={`px-4 py-2 ${buttonPrimaryClass} text-white rounded-md`}
                >
                  Add First Machine
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add Machine Modal */}
      {isAddingMachine && (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className={`rounded-lg border w-full max-w-md ${cardBgClass} ${cardBorderClass}`}>
            <div className={`p-6 border-b ${cardBorderClass}`}>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-semibold ${textClass}`}>Add New Machine</h3>
                <button 
                  onClick={() => setIsAddingMachine(false)}
                  className={textSecondaryClass}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                  Machine Name *
                </label>
                <input
                  type="text"
                  required
                  className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  value={newMachine.name}
                  onChange={(e) => setNewMachine({...newMachine, name: e.target.value})}
                />
              </div>
              
              <div>
                <label className={`block text-sm font-medium mb-1 ${textSecondaryClass}`}>
                  Description
                </label>
                <textarea
                  rows={3}
                  className={`w-full px-3 py-2 ${inputBgClass} border ${inputBorderClass} rounded-md ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  value={newMachine.description}
                  onChange={(e) => setNewMachine({...newMachine, description: e.target.value})}
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => setIsAddingMachine(false)}
                  className={`px-4 py-2 border ${buttonSecondaryClass} rounded-md`}
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddMachine}
                  className={`px-4 py-2 ${buttonPrimaryClass} text-white rounded-md`}
                >
                  Add Machine
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Layout Controls */}
      {editLayoutMode && (
        <div className={`rounded-lg border p-4 flex justify-between items-center ${cardBgClass} ${cardBorderClass}`}>
          <div className={`${isDarkMode ? 'text-yellow-400' : 'text-amber-600'}`}>
            <p className="flex items-center">
              <Edit className="h-4 w-4 mr-2" />
              <span>Layout Edit Mode: Drag machines to reposition, resize with bottom-right handle, or delete with trash icon</span>
            </p>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setEditLayoutMode(false)}
              className={`px-4 py-2 border ${buttonSecondaryClass} rounded-md`}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveLayout}
              className={`px-4 py-2 ${isDarkMode ? 'bg-green-600 hover:bg-green-700' : 'bg-green-600 hover:bg-green-500'} text-white rounded-md flex items-center`}
            >
              <Save className="h-4 w-4 mr-2" />
              Save Layout
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DepartmentView;
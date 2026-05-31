import { useState, useEffect, useContext } from 'react';
import { ProductionTimelineDay, ProductionHour, StoppageRecord, User, Mold } from '../types';
import { format, parseISO, isToday} from 'date-fns';
import socketService from '../services/socket';
import apiService from '../services/api';
import { 
  Clock, 
  User as UserIcon, 
  Wrench, 
  AlertTriangle, 
  X, 
  Plus,
  Play,
  TrendingUp,
  TrendingDown,
  Activity,
  ChevronLeft,
  ChevronRight,
  Zap,
  ZapOff,
  Calendar,
  Check,
} from 'lucide-react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { useAuth } from '../context/AuthContext';
import { ThemeContext } from '../App';

interface ProductionTimelineProps {
  machineId: string;
  onAddStoppage?: (stoppage: Partial<StoppageRecord>) => void;
  onUpdateProduction?: (machineId: string, hour: number, date: string, data: any) => void;
}

interface ProductionModalProps {
  isOpen: boolean;
  onClose: () => void;
  hour: ProductionHour;
  date: string;
  machineId: string;
  onAddStoppage?: (stoppage: Partial<StoppageRecord>) => void;
  onUpdateProduction?: (machineId: string, hour: number, date: string, data: any) => void;
  availableOperators?: User[];
  availableMolds?: Mold[];
  shifts: any[];
}

const ProductionModal: React.FC<ProductionModalProps> = ({
  isOpen,
  onClose,
  hour,
  date,
  machineId,
  availableOperators = [],
  availableMolds = [],
  shifts = []
}) => {
  const { isDarkMode } = useContext(ThemeContext);
  const [activeTab, setActiveTab] = useState<'details' | 'stoppage' | 'assignment'>('details');
  const { user: currentUser } = useAuth();
  
  const [stoppageForm, setStoppageForm] = useState({
    reason: '',
    description: '',
    duration: 5,
    sapNotificationNumber: ''
  });
  const [assignmentForm, setAssignmentForm] = useState({
    operatorId: currentUser?.role === 'operator' 
      ? (currentUser._id || '')
      : (hour.operator?._id || ''),
    moldId: hour.mold?._id || '',
    defectiveUnits: hour.defectiveUnits || 0
  });
  const [applyToShift, setApplyToShift] = useState(false);
  const [shiftInfo, setShiftInfo] = useState<{name: string; hours: number[]} | null>(null);
  const [operatorSearch, setOperatorSearch] = useState('');
  const [moldSearch, setMoldSearch] = useState('');
  const [showOperatorResults, setShowOperatorResults] = useState(false);
  const [showMoldResults, setShowMoldResults] = useState(false);
  
  // Theme classes
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

  // Check for pending stoppages
  const pendingStoppage = hour.stoppages.find(s => s.reason === 'unclassified' || (s as any).isPending);

  // Filtered lists based on search
  const filteredOperators = availableOperators.filter(op =>
    op.username.toLowerCase().includes(operatorSearch.toLowerCase())
  );
  
  const filteredMolds = availableMolds.filter(mold =>
    mold.name.toLowerCase().includes(moldSearch.toLowerCase())
  );

  // Initialize search values based on current assignment
  useEffect(() => {
    setOperatorSearch(hour.operator?.username || '');
    setMoldSearch(hour.mold?.name || '');
  }, [hour]);

  // Detect shift when hour changes
  useEffect(() => {
    if (shifts.length > 0 && hour) {
      // Find shift containing the current hour
      const currentShift = shifts.find(shift => {
        const startHour = parseInt(shift.startTime.split(':')[0]);
        const endHour = parseInt(shift.endTime.split(':')[0]);
        
        if (endHour > startHour) {
          return hour.hour >= startHour && hour.hour < endHour;
        } else {
          return hour.hour >= startHour || hour.hour < endHour;
        }
      });

      if (currentShift) {
        const startHour = parseInt(currentShift.startTime.split(':')[0]);
        const endHour = parseInt(currentShift.endTime.split(':')[0]);
        const shiftHours = [];

        if (startHour <= endHour) {
          for (let h = startHour; h < endHour; h++) {
            shiftHours.push(h);
          }
        } else {
          if (hour.hour >= startHour) {
            for (let h = startHour; h < 24; h++) shiftHours.push(h);
          } else if (hour.hour < endHour) {
            for (let h = 0; h < endHour; h++) shiftHours.push(h);
          }
        }

        setShiftInfo({
          name: currentShift.name,
          hours: shiftHours
        });
        setApplyToShift(false);
      } else {
        setShiftInfo(null);
        setApplyToShift(false);
      }
    }
  }, [shifts, hour]);

  if (!isOpen) return null;

  const handleStoppageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stoppageForm.reason.trim()) return;

    // Validate SAP notification number for breakdown
    if (stoppageForm.reason === 'breakdown') {
      if (!stoppageForm.sapNotificationNumber || stoppageForm.sapNotificationNumber.trim() === '') {
        toast.error('SAP notification number is required for breakdown stoppages');
        return;
      }
      if (!/^\d+$/.test(stoppageForm.sapNotificationNumber.trim())) {
        toast.error('SAP notification number must contain only numbers');
        return;
      }
    }
    try {
      const stoppageData = {
        machineId,
        hour: hour.hour,
        date,
        reason: stoppageForm.reason,
        description: stoppageForm.description.trim(),
        duration: stoppageForm.duration,
        ...(stoppageForm.reason === 'breakdown' && { sapNotificationNumber: stoppageForm.sapNotificationNumber }),
        ...(pendingStoppage && { pendingStoppageId: (pendingStoppage as any)._id })
      };

      await apiService.addStoppageRecord(stoppageData);
      
      setStoppageForm({ reason: '', description: '', duration: 5, sapNotificationNumber: '' });
      toast.success('Stoppage recorded successfully');
      onClose();
    } catch (error) {
      console.error('Failed to add stoppage:', error);
      toast.error('Failed to record stoppage');
    }

    socketService.emit('stoppage-updated', {
      machineId,
      date,
      hour: hour.hour
    });
  };

  const handleAssignmentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const operatorId = assignmentForm.operatorId === '' ? null : assignmentForm.operatorId;
    const moldId = assignmentForm.moldId === '' ? null : assignmentForm.moldId;

    try {
      await apiService.updateProductionAssignment({
        machineId,
        hour: hour.hour,
        date,
        operatorId,
        moldId,
        defectiveUnits: assignmentForm.defectiveUnits,
        applyToShift: shiftInfo ? applyToShift : false
      });
      
      const message = applyToShift && shiftInfo 
        ? `Assignment updated for entire ${shiftInfo.name} shift` 
        : 'Assignment updated successfully';
      
      toast.success(message);
      onClose();
      
    } catch (error) {
      console.error('Failed to update assignment:', error);
      toast.error('Failed to update assignment');
    }

    socketService.emit('production-assignment-updated', {
      machineId,
      date,
      hours: applyToShift && shiftInfo ? shiftInfo.hours : [hour.hour],
      originalHour: hour.hour,
      operatorId: operatorId,
      moldId: moldId,
      defectiveUnits: assignmentForm.defectiveUnits
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return isDarkMode ? 'text-green-400' : 'text-green-600';
      case 'stoppage': return isDarkMode ? 'text-red-400' : 'text-red-600';
      case 'stopped_yet_producing': return isDarkMode ? 'text-orange-400' : 'text-orange-600';
      case 'inactive': return isDarkMode ? 'text-gray-400' : 'text-gray-600';
      default: return isDarkMode ? 'text-gray-400' : 'text-gray-600';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running': return <Play className="h-4 w-4" />;
      case 'stoppage': return <AlertTriangle className="h-4 w-4" />;
      case 'stopped_yet_producing': return <ZapOff className="h-4 w-4" />;
      case 'inactive': return <Activity className="h-4 w-4" />;
      default: return <Activity className="h-4 w-4" />;
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`rounded-lg border w-full max-w-2xl max-h-[90vh] overflow-y-auto ${cardBgClass} ${cardBorderClass}`}>
        <div className={`flex items-center justify-between p-6 border-b ${cardBorderClass}`}>
          <h3 className={`text-lg font-semibold ${textClass}`}>
            Production Details - {format(new Date(date), 'MMM dd')}, {hour.hour.toString().padStart(2, '0')}:00
            {pendingStoppage && (
              <span className={`ml-2 text-sm animate-pulse ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
                (Unclassified Stoppage - Needs Categorization)
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className={textSecondaryClass}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className={`border-b ${cardBorderClass}`}>
          <nav className="flex space-x-8 px-6">
            {[
              { id: 'details', label: 'Details', icon: Activity },
              { id: 'assignment', label: 'Assignment', icon: UserIcon },
              { id: 'stoppage', label: pendingStoppage ? 'Categorize Stoppage' : 'Add Stoppage', icon: pendingStoppage ? AlertTriangle : Plus }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-2 py-3 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : `border-transparent ${textSecondaryClass} hover:${textClass}`
                } ${pendingStoppage && tab.id === 'stoppage' ? (isDarkMode ? 'text-red-400' : 'text-red-600') + ' animate-pulse' : ''}`}
              >
                <tab.icon className="h-4 w-4" />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {/* Details Tab */}
          {activeTab === 'details' && (
            <div className="space-y-6">
              {/* Production Summary */}
              <div className={`rounded-lg p-4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <h4 className={`text-sm font-medium ${textClass} mb-3`}>Production Summary</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <TrendingUp className={`h-5 w-5 ${isDarkMode ? 'text-green-400' : 'text-green-500'}`} />
                    </div>
                    <div className={`text-2xl font-bold ${textClass}`}>{hour.unitsProduced}</div>
                    <div className={`text-xs ${textSecondaryClass}`}>Units Produced</div>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <TrendingDown className={`h-5 w-5 ${isDarkMode ? 'text-red-400' : 'text-red-500'}`} />
                    </div>
                    <div className={`text-2xl font-bold ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{hour.defectiveUnits}</div>
                    <div className={`text-xs ${textSecondaryClass}`}>Defective Units</div>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <div className={getStatusColor(hour.status)}>
                        {getStatusIcon(hour.status)}
                      </div>
                    </div>
                    <div className={`text-sm font-medium capitalize ${getStatusColor(hour.status)}`}>
                      {hour.status.replace('_', ' ')}
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>Status</div>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <Activity className={`h-5 w-5 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
                    </div>
                    <div className={`text-2xl font-bold ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                      {hour.unitsProduced > 0 ? ((hour.unitsProduced - hour.defectiveUnits) / hour.unitsProduced * 100).toFixed(1) : 0}%
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>Quality Rate</div>
                  </div>
                </div>
              </div>

              {/* Time Distribution */}
              <div className={`rounded-lg p-4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <h4 className={`text-sm font-medium ${textClass} mb-3`}>Time Distribution</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className={`text-lg font-bold ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>
                      {Math.min(60, hour.runningMinutes || 0)}m
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>Running Time</div>
                  </div>
                  <div className="text-center">
                    <div className={`text-lg font-bold ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
                      {Math.min(60, hour.stoppageMinutes || 0)}m
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>Stoppage Time</div>
                  </div>
                  <div className="text-center">
                    <div className={`text-lg font-bold ${textSecondaryClass}`}>
                      {60 - Math.min(60, hour.runningMinutes || 0) - Math.min(60, hour.stoppageMinutes || 0)}m
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>Inactive Time</div>
                  </div>
                </div>
                
                {/* Visual time bar */}
                <div className="mt-3 h-4 bg-gray-600 rounded-full overflow-hidden">
                  <div className="h-full flex">
                    <div 
                      className="bg-green-500" 
                      style={{ width: `${Math.min(100, ((hour.runningMinutes || 0) / 60) * 100)}%` }}
                    ></div>
                    <div 
                      className="bg-red-500" 
                      style={{ width: `${Math.min(100, ((hour.stoppageMinutes || 0) / 60) * 100)}%` }}
                    ></div>
                    <div 
                      className="bg-gray-500" 
                      style={{ width: `${Math.max(0, ((60 - (hour.runningMinutes || 0) - (hour.stoppageMinutes || 0)) / 60) * 100)}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              {/* Assignment Information */}
              <div className={`rounded-lg p-4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <h4 className={`text-sm font-medium ${textClass} mb-3`}>Assignment Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center space-x-3">
                    <UserIcon className={`h-5 w-5 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
                    <div>
                      <div className={`text-sm ${textSecondaryClass}`}>Operator</div>
                      <div className={`font-medium ${textClass}`}>
                        {hour.operator?.username || 'Not assigned'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <Wrench className={`h-5 w-5 ${isDarkMode ? 'text-purple-400' : 'text-purple-500'}`} />
                    <div>
                      <div className={`text-sm ${textSecondaryClass}`}>Mold</div>
                      <div className={`font-medium ${textClass}`}>
                        {hour.mold?.name || 'Not assigned'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stoppages */}
              {hour.stoppages.length > 0 && (
                <div className={`rounded-lg p-4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                  <h4 className={`text-sm font-medium ${textClass} mb-3`}>Stoppages</h4>
                  <div className="space-y-3">
                    {hour.stoppages.map((stoppage, index) => (
                      <div key={index} className={`rounded-lg p-3 ${
                        stoppage.reason === 'unclassified' || (stoppage as any).isPending 
                          ? isDarkMode 
                            ? 'bg-red-900/20 border border-red-500' 
                            : 'bg-red-100 border border-red-300'
                          : isDarkMode 
                            ? 'bg-gray-600' 
                            : 'bg-gray-200'
                      }`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-2">
                            <AlertTriangle className={`h-4 w-4 ${
                              stoppage.reason === 'unclassified' || (stoppage as any).isPending 
                                ? isDarkMode 
                                  ? 'text-red-400' 
                                  : 'text-red-600'
                                : isDarkMode 
                                  ? 'text-red-400' 
                                  : 'text-red-600'
                            }`} />
                            <span className={`text-sm font-medium ${textClass} capitalize`}>
                              {stoppage.reason === 'unclassified' ? 'Pending Categorization' : stoppage.reason.replace('_', ' ')}
                            </span>
                          </div>
                          <span className={`text-xs ${textSecondaryClass}`}>
                            {stoppage.duration || 0} min
                          </span>
                        </div>
                        {stoppage.description && (
                          <p className={`text-xs ml-6 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{stoppage.description}</p>
                        )}
                        {(stoppage.reason === 'unclassified' || (stoppage as any).isPending) && (
                          <p className={`text-xs ml-6 mt-1 ${isDarkMode ? 'text-red-300' : 'text-red-600'}`}>
                            Click "Categorize Stoppage" tab to assign a reason
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Assignment Tab */}
          {activeTab === 'assignment' && (
            <form onSubmit={handleAssignmentSubmit} className="space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                  Operator
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={operatorSearch}
                    onChange={(e) => {
                      setOperatorSearch(e.target.value);
                      setShowOperatorResults(true);
                    }}
                    onFocus={() => setShowOperatorResults(true)}
                    onBlur={() => setTimeout(() => setShowOperatorResults(false), 200)}
                    className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    placeholder="Search operators..."
                  />
                  {operatorSearch && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                      onClick={() => {
                        setOperatorSearch('');
                        setAssignmentForm(prev => ({ ...prev, operatorId: '' }));
                      }}
                    >
                      <X className={`h-4 w-4 ${textSecondaryClass}`} />
                    </button>
                  )}
                  {showOperatorResults && operatorSearch && (
                    <div 
                      className={`absolute z-10 w-full mt-1 max-h-60 overflow-auto rounded-md shadow-lg ${
                        isDarkMode ? `bg-gray-800 border border-gray-700 ${textClass}` :  `bg-white border border-gray-200 ${textClass}`
                      }`}
                    >
                      {filteredOperators.length > 0 ? (
                        filteredOperators.map((operator) => (
                          <div
                            key={operator._id}
                            onMouseDown={(e) => e.preventDefault()} // Prevent onBlur from firing
                            onClick={() => {
                              setAssignmentForm(prev => ({ 
                                ...prev, 
                                operatorId: operator._id || ''
                              }));
                              setOperatorSearch(operator.username);
                              setShowOperatorResults(false);
                            }}
                            className={`px-4 py-2 cursor-pointer ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                          >
                            {operator.username}
                          </div>
                        ))
                      ) : (
                        <div className={`px-4 py-2 ${textSecondaryClass}`}>
                          No operators found
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

               <div>
                <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                  Mold
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={moldSearch}
                    onChange={(e) => {
                      setMoldSearch(e.target.value);
                      setShowMoldResults(true);
                    }}
                    onFocus={() => setShowMoldResults(true)}
                    onBlur={() => setTimeout(() => setShowMoldResults(false), 200)}
                    className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    placeholder="Search molds..."
                  />
                  {moldSearch && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2"
                      onClick={() => {
                        setMoldSearch('');
                        setAssignmentForm(prev => ({ ...prev, moldId: '' }));
                      }}
                    >
                      <X className={`h-4 w-4 ${textSecondaryClass}`} />
                    </button>
                  )}
                  {showMoldResults && moldSearch && (
                    <div 
                      className={`absolute z-10 w-full mt-1 max-h-60 overflow-auto rounded-md shadow-lg ${
                        isDarkMode ? `bg-gray-800 border border-gray-700 ${textClass}` : `bg-white border border-gray-200 ${textClass}`
                      }`}
                    >
                    {filteredMolds.length > 0 ? (
                        filteredMolds.map((mold) => (
                          <div
                            key={mold._id}
                            onMouseDown={(e) => e.preventDefault()} // Prevent onBlur from firing
                            onClick={() => {
                              setAssignmentForm(prev => ({ 
                                ...prev, 
                                moldId: mold._id 
                              }));
                              setMoldSearch(mold.name);
                              setShowMoldResults(false);
                            }}
                            className={`px-4 py-2 cursor-pointer ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                          >
                            {mold.name}
                          </div>
                        ))
                      ) : (
                        <div className={`px-4 py-2 ${textSecondaryClass}`}>
                          No molds found
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                  Defective Units
                </label>
                <input
                  type="number"
                  min="0"
                  value={assignmentForm.defectiveUnits}
                  onChange={(e) => setAssignmentForm({...assignmentForm, defectiveUnits: parseInt(e.target.value) || 0})}
                  className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                />
              </div>

              {/* Shift Assignment Section */}
              {shiftInfo && (
                <div className={`mt-4 p-3 rounded-lg border ${isDarkMode ? 'bg-gray-750 border-blue-500/30' : 'bg-blue-50 border-blue-300'}`}>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="applyToShift"
                      checked={applyToShift}
                      onChange={(e) => setApplyToShift(e.target.checked)}
                      className={`h-4 w-4 text-blue-600 rounded ${inputBorderClass} ${inputBgClass} focus:ring-blue-500`}
                    />
                    <label htmlFor="applyToShift" className={`ml-2 text-sm font-medium ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                      Apply to entire shift ({shiftInfo.name})
                    </label>
                  </div>
                  
                  {applyToShift && (
                    <div className={`mt-2 text-xs ${textSecondaryClass}`}>
                      <p>This will apply operator and mold to:</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {shiftInfo.hours.map(h => (
                          <span 
                            key={h} 
                            className={`px-2 py-1 rounded ${
                              h === hour.hour 
                                ? 'bg-blue-600 text-white' 
                                : `${isDarkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'}`
                            }`}
                          >
                            {h.toString().padStart(2, '0')}:00
                          </span>
                        ))}
                      </div>
                      <p className={`mt-2 ${isDarkMode ? 'text-blue-300' : 'text-blue-600'}`}>
                        Note: Defective units will only be updated for the current hour ({hour.hour}:00)
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex space-x-3 pt-4">
                <button
                  type="submit"
                  className={`flex-1 py-2 px-4 rounded-md ${buttonPrimaryClass} text-white`}
                >
                  Update Assignment
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className={`px-4 py-2 ${buttonSecondaryClass} rounded-md`}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Stoppage Tab */}
          {activeTab === 'stoppage' && (
            <form onSubmit={handleStoppageSubmit} className="space-y-4">
              {pendingStoppage && (
                <div className={`rounded-lg p-4 mb-4 ${
                  isDarkMode ? 'bg-red-900/20 border border-red-500' : 'bg-red-100 border border-red-300'
                }`}>
                  <div className="flex items-center space-x-2 mb-2">
                    <AlertTriangle className={`h-5 w-5 ${isDarkMode ? 'text-red-400' : 'text-red-600'}`} />
                    <h4 className={`font-medium ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>Unclassified Stoppage Detected</h4>
                  </div>
                  <p className={`text-sm ${isDarkMode ? 'text-red-300' : 'text-red-700'}`}>
                    An unclassified stoppage was automatically detected for {pendingStoppage.duration} minutes. 
                    Please categorize the reason for this stoppage.
                  </p>
                </div>
              )}

              <div>
                <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                  Stoppage Reason *
                </label>
                <select
                  required
                  value={stoppageForm.reason}
                  onChange={(e) => setStoppageForm({...stoppageForm, reason: e.target.value})}
                  className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                >
                  <option value="">Select reason...</option>
                  <option value="planned">Planned Maintenance</option>
                  <option value="mold_change">Mold Change</option>
                  <option value="breakdown">Breakdown</option>
                  <option value="maintenance">Unplanned Maintenance</option>
                  <option value="material_shortage">Material Shortage</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {!pendingStoppage && (
                <div>
                  <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                    Duration (minutes) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    max="60"
                    value={stoppageForm.duration}
                    onChange={(e) => setStoppageForm({...stoppageForm, duration: parseInt(e.target.value) || 5})}
                    className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  />
                </div>
              )}

              <div>
                <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                  Description
                </label>
                <textarea
                  value={stoppageForm.description}
                  onChange={(e) => setStoppageForm({...stoppageForm, description: e.target.value})}
                  rows={3}
                  className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  placeholder="Additional details about the stoppage..."
                />
              </div>

              {stoppageForm.reason === 'breakdown' && (
                <div>
                  <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                    SAP Notification Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={stoppageForm.sapNotificationNumber}
                    onChange={(e) => setStoppageForm({...stoppageForm, sapNotificationNumber: e.target.value})}
                    className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    placeholder="Enter SAP notification number (numbers only)"
                    pattern="[0-9]*"
                  />
                  <p className={`text-xs mt-1 ${textSecondaryClass}`}>
                    Required for breakdown stoppages. Numbers only.
                  </p>
                </div>
              )}
              <div className="flex space-x-3 pt-4">
                <button
                  type="submit"
                  disabled={!stoppageForm.reason.trim()}
                  className={`flex-1 py-2 px-4 rounded-md ${isDarkMode ? 'bg-red-600 hover:bg-red-700' : 'bg-red-600 hover:bg-red-500'} text-white disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {pendingStoppage ? 'Categorize Stoppage' : 'Add Stoppage'}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className={`px-4 py-2 ${buttonSecondaryClass} rounded-md`}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

const ProductionTimeline: React.FC<ProductionTimelineProps> = ({ 
  machineId, 
  onAddStoppage, 
  onUpdateProduction,
}) => {
  const { isDarkMode } = useContext(ThemeContext);
  const [data, setData] = useState<ProductionTimelineDay[]>([]);
  const [selectedHour, setSelectedHour] = useState<{ hour: ProductionHour; date: string } | null>(null);
  const [timeframe, setTimeframe] = useState<'today' | 'week' | 'month' | 'custom'>('today');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [appliedCustomDates, setAppliedCustomDates] = useState({ start: '', end: '' });
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [availableOperators, setAvailableOperators] = useState<User[]>([]);
  const [availableMolds, setAvailableMolds] = useState<Mold[]>([]);
  const [machineStatus, setMachineStatus] = useState<string>('inactive');
  const [machineColor, setMachineColor] = useState<string>('gray');
  const [shifts, setShifts] = useState<any[]>([]);
  const { user: currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(false);

  // Theme classes
  const cardBgClass = isDarkMode ? 'bg-gray-800' : 'bg-white';
  const cardBorderClass = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const textClass = isDarkMode ? 'text-white' : 'text-gray-900';
  const textSecondaryClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
  const buttonSecondaryClass = isDarkMode 
    ? 'border-gray-600 text-gray-300 hover:bg-gray-700' 
    : 'border-gray-300 text-gray-700 hover:bg-gray-100';

  // Check for unapplied custom date changes
  const hasUnappliedChanges = timeframe === 'custom' && 
    (customStartDate !== appliedCustomDates.start || customEndDate !== appliedCustomDates.end) &&
    customStartDate && customEndDate;

  const fetchProductionData = async () => {
    setIsLoading(true);
    try {
      let params: any = { timeframe };
      
      if (timeframe === 'custom') {
        params.startDate = appliedCustomDates.start;
        params.endDate = appliedCustomDates.end;
      }

      const response = await apiService.getProductionTimeline(machineId, params);
      setData(response.timeline || []);
      
      // Auto-select today when data changes
      if (response.timeline?.length > 0) {
        const todayIndex = response.timeline.findIndex((day: any) => isToday(parseISO(day.date)));
        setSelectedDayIndex(todayIndex >= 0 ? todayIndex : 0);
      }
    } catch (error) {
      console.error('Failed to fetch production data:', error);
      toast.error('Failed to load production data');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchOperatorsAndMolds = async () => {
    try {
      let operators: User[] = [];
      if (currentUser?.role === 'admin') {
        operators = await apiService.getUsers();
      } else {
        const operator = await apiService.getCurrentUser();
        operators = [operator];
      }
      
      operators = operators.filter(u => u.role === 'operator');
      const molds = await apiService.getMolds();
      
      setAvailableOperators(operators);
      setAvailableMolds(molds);
      
      return { operators, molds };
    } catch (error) {
      console.error('Failed to fetch operators and molds:', error);
      return { operators: [], molds: [] };
    }
  };
  
  useEffect(() => {
    fetchProductionData();
  }, [timeframe, machineId, appliedCustomDates]);

  useEffect(() => {
    fetchOperatorsAndMolds();
  }, [currentUser]);

  useEffect(() => {
    socketService.connect();
    socketService.joinMachine(machineId);

    const handleProductionUpdate = (update: any) => {
      if (update.machineId === machineId) {
        setData(prevData => {
          const newData = [...prevData];
          const dayIndex = newData.findIndex(day => day.date === update.date);
          
          if (dayIndex >= 0) {
            const hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === update.hour);
            if (hourIndex >= 0) {
              newData[dayIndex].hours[hourIndex] = {
                ...newData[dayIndex].hours[hourIndex],
                unitsProduced: update.unitsProduced,
                status: update.status,
                runningMinutes: update.runningMinutes || newData[dayIndex].hours[hourIndex].runningMinutes,
                stoppageMinutes: update.stoppageMinutes || newData[dayIndex].hours[hourIndex].stoppageMinutes
              };
            }
          }
          return newData;
        });
      }
    };

    const handleRunningTimeUpdate = (update: any) => {
      if (update.machineId === machineId) {
        setData(prevData => {
          const newData = [...prevData];
          const dayIndex = newData.findIndex(day => day.date === update.date);
          
          if (dayIndex >= 0) {
            const hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === update.hour);
            if (hourIndex >= 0) {
              newData[dayIndex].hours[hourIndex] = {
                ...newData[dayIndex].hours[hourIndex],
                runningMinutes: update.runningMinutes,
                status: 'running'
              };
            }
          }
          return newData;
        });
      }
    };

    const handleMachineStateUpdate = (update: any) => {
      if (update.machineId === machineId) {
        setMachineStatus(update.status);
        setMachineColor(update.color);
      }
    };

    const handleUnclassifiedStoppageDetected = (stoppage: any) => {
      if (stoppage.machineId === machineId) {
        setData(prevData => {
          const newData = [...prevData];
          const dayIndex = newData.findIndex(day => day.date === stoppage.date);
          
          if (dayIndex >= 0) {
            const hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === stoppage.hour);
            if (hourIndex >= 0) {
              const unclassifiedStoppageRecord: StoppageRecord = {
                _id: stoppage.pendingStoppageId || `unclassified_${Date.now()}`,
                reason: 'unclassified',
                description: 'Automatic stoppage detection - awaiting categorization',
                startTime: stoppage.stoppageStart,
                endTime: null,
                duration: stoppage.duration || 0
              };

              const existingIndex = newData[dayIndex].hours[hourIndex].stoppages.findIndex(
                s => s._id === stoppage.pendingStoppageId || s.reason === 'unclassified'
              );

              if (existingIndex === -1) {
                newData[dayIndex].hours[hourIndex].stoppages.push(unclassifiedStoppageRecord);
              }

              newData[dayIndex].hours[hourIndex].status = 'stoppage';
              newData[dayIndex].hours[hourIndex].stoppageMinutes = 
                (newData[dayIndex].hours[hourIndex].stoppageMinutes || 0) + (stoppage.duration || 0);
            }
          }
          
          return newData;
        });

        toast.warning(`Unclassified stoppage detected - requires categorization`, {
          position: "top-right",
          autoClose: 5000,
          theme: isDarkMode ? "dark" : "light"
        });
      }
    };

    const handleStoppageAdded = (stoppage: any) => {
      if (stoppage.machineId === machineId) {
        setData(prevData => {
          const newData = [...prevData];
          const dayIndex = newData.findIndex(day => day.date === stoppage.date);
          
          if (dayIndex >= 0) {
            const hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === stoppage.hour);
            if (hourIndex >= 0) {
              newData[dayIndex].hours[hourIndex].stoppages = 
                newData[dayIndex].hours[hourIndex].stoppages.filter(s => s.reason !== 'unclassified');
              
              newData[dayIndex].hours[hourIndex].stoppages.push({
                _id: `stoppage_${Date.now()}`,
                reason: stoppage.stoppage.reason as any,
                description: stoppage.stoppage.description,
                startTime: new Date().toISOString(),
                endTime: null,
                duration: stoppage.stoppage.duration
              });

              if (stoppage.stoppage.reason === 'breakdown') {
                newData[dayIndex].hours[hourIndex].status = 'stoppage';
              } else {
                newData[dayIndex].hours[hourIndex].status = 'stoppage';
              }
            }

            newData[dayIndex].hours[hourIndex].stoppageMinutes = 
            newData[dayIndex].hours[hourIndex].stoppages.reduce(
              (sum, s) => sum + (s.duration || 0), 0
            );

          }

          return newData;
        });
      }
    };

    const handleProductionAssignmentUpdated = async (update: any) => {
      if (update.machineId === machineId) {
        try {
          const { operators, molds } = await fetchOperatorsAndMolds();
          
          setData(prevData => {
            const newData = [...prevData];
            const dayIndex = newData.findIndex(day => day.date === update.date);
            
            if (dayIndex >= 0) {
              update.hours.forEach((targetHour: number) => {
                let hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === targetHour);

                if (hourIndex === -1) {
                  const newHour: ProductionHour = {
                    hour: targetHour,
                    unitsProduced: 0,
                    defectiveUnits: 0,
                    status: 'inactive',
                    operator: undefined,
                    mold: undefined,
                    stoppages: [],
                    runningMinutes: 0,
                    stoppageMinutes: 0
                  };
                  newData[dayIndex].hours.push(newHour);
                  hourIndex = newData[dayIndex].hours.length - 1;
                }

                if (hourIndex >= 0) {
                  if (update.operatorId !== null) {
                    const operator = operators.find(op => op._id === update.operatorId);
                    newData[dayIndex].hours[hourIndex].operator = operator || undefined;
                  } else {
                    newData[dayIndex].hours[hourIndex].operator = undefined;
                  }
                  
                  if (update.moldId !== null) {
                    const mold = molds.find((m: any) => m._id === update.moldId);
                    newData[dayIndex].hours[hourIndex].mold = mold || undefined;
                  } else {
                    newData[dayIndex].hours[hourIndex].mold = undefined;
                  }
                  
                  if (targetHour === update.originalHour && update.defectiveUnits !== undefined) {
                    newData[dayIndex].hours[hourIndex].defectiveUnits = update.defectiveUnits;
                  }
                }
              });
            }
            return newData;
          });
        } catch (error) {
          console.error('Failed to update assignment:', error);
        }
      }
    };

    const handleStoppageUpdated = (update: any) => {
      if (update.machineId === machineId) {
        setData(prevData => {
          const newData = [...prevData];
          const dayIndex = newData.findIndex(day => day.date === update.date);
          
          if (dayIndex >= 0) {
            const hourIndex = newData[dayIndex].hours.findIndex(h => h.hour === update.hour);
            if (hourIndex >= 0) {
              const stoppageIndex = newData[dayIndex].hours[hourIndex].stoppages.findIndex(
                s => s._id === update.stoppageId
              );
              
              if (stoppageIndex >= 0) {
                newData[dayIndex].hours[hourIndex].stoppages[stoppageIndex] = {
                  ...newData[dayIndex].hours[hourIndex].stoppages[stoppageIndex],
                  duration: update.duration,
                  startTime: new Date(Date.now() - update.duration * 60000).toISOString()
                };
                
                newData[dayIndex].hours[hourIndex].stoppageMinutes = 
                  newData[dayIndex].hours[hourIndex].stoppages.reduce(
                    (sum, stoppage) => sum + (stoppage.duration || 0), 0
                  );
              }
            }
          }
          return newData;
        });
      }
    };

    socketService.on('production-update', handleProductionUpdate);
    socketService.on('running-time-update', handleRunningTimeUpdate);
    socketService.on('machine-state-update', handleMachineStateUpdate);
    socketService.on('unclassified-stoppage-detected', handleUnclassifiedStoppageDetected);
    socketService.on('stoppage-added', handleStoppageAdded);
    socketService.on('production-assignment-updated', handleProductionAssignmentUpdated);
    socketService.on('stoppage-updated', handleStoppageUpdated);

    return () => {
      socketService.off('production-update', handleProductionUpdate);
      socketService.off('running-time-update', handleRunningTimeUpdate);
      socketService.off('machine-state-update', handleMachineStateUpdate);
      socketService.off('unclassified-stoppage-detected', handleUnclassifiedStoppageDetected);
      socketService.off('stoppage-added', handleStoppageAdded);
      socketService.off('production-assignment-updated', handleProductionAssignmentUpdated);
      socketService.off('stoppage-updated', handleStoppageUpdated);
      socketService.leaveMachine(machineId);
    };
  }, [machineId, availableOperators, availableMolds]);

  useEffect(() => {
    const fetchShifts = async () => {
      try {
        const shifts = await apiService.getShifts();
        setShifts(shifts || []);
      } catch (error) {
        console.error('Failed to fetch shifts:', error);
      }
    };
    
    fetchShifts();
  }, [currentUser]);

  const handleTimeframeChange = (newTimeframe: 'today' | 'week' | 'month' | 'custom') => {
    setTimeframe(newTimeframe);
    if (newTimeframe !== 'custom') {
      setSelectedDayIndex(0);
    }
  };

  const handleApplyCustomDates = () => {
    if (!customStartDate || !customEndDate) {
      toast.error('Please select both start and end dates');
      return;
    }
    
    if (customStartDate > customEndDate) {
      toast.error('Start date must be before end date');
      return;
    }
    
    setAppliedCustomDates({ start: customStartDate, end: customEndDate });
    setTimeframe('custom');
  };

  const formatTime = (hour: number) => {
    return `${hour.toString().padStart(2, '0')}:00`;
  };

  const currentDay = data[selectedDayIndex] || data[0];

  if (isLoading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
        <p className={`mt-2 ${textSecondaryClass}`}>Loading production data...</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8">
        <Clock className={`h-8 w-8 mx-auto mb-2 ${textSecondaryClass}`} />
        <p className={textSecondaryClass}>No production data available</p>
      </div>
    );
  }

  if (!currentDay) {
    return (
      <div className="text-center py-8">
        <Clock className={`h-8 w-8 mx-auto mb-2 ${textSecondaryClass}`} />
        <p className={textSecondaryClass}>No data available for selected period</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ToastContainer
        position="top-right"
        autoClose= {5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme={isDarkMode ? "dark" : "light"}
      />

      {/* Timeframe Selector - Enhanced */}
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center space-y-2 md:space-y-0 md:space-x-4">
          <span className={`text-sm font-medium ${textSecondaryClass}`}>View Analytics For:</span>
          <div className="flex flex-wrap gap-2">
            {[
              { value: 'today', label: 'Today' },
              { value: 'week', label: 'This Week' },
              { value: 'month', label: 'Month to Date' },
              { value: 'custom', label: 'Custom Range' }
            ].map((period) => (
              <button
                key={period.value}
                onClick={() => handleTimeframeChange(period.value as any)}
                className={`px-4 py-2 text-sm rounded-lg transition-all duration-200 flex items-center font-medium ${
                  timeframe === period.value
                    ? 'bg-blue-600 text-white shadow-md transform scale-105'
                    : `${buttonSecondaryClass} hover:shadow-sm`
                }`}
              >
                {period.value === 'custom' && <Calendar className="h-4 w-4 mr-2" />}
                {period.label}
              </button>
            ))}
          </div>
        </div>
        
        {/* Enhanced Custom Date Picker */}
        {timeframe === 'custom' && (
          <div className={`rounded-xl p-6 border-2 border-dashed transition-all duration-300 ${
            isDarkMode 
              ? 'bg-gray-800/50 border-gray-600 hover:border-gray-500 hover:bg-gray-800/70' 
              : 'bg-blue-50/50 border-blue-200 hover:border-blue-300 hover:bg-blue-50/70'
          }`}>
            <div className="flex items-center space-x-3 mb-4">
              <Calendar className={`h-5 w-5 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`} />
              <h3 className={`text-lg font-semibold ${textClass}`}>Custom Date Range</h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              {/* Start Date */}
              <div className="space-y-2">
                <label className={`text-sm font-medium ${textSecondaryClass} block`}>
                  Start Date
                </label>
                <div className="relative">
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className={`w-full px-4 py-3 rounded-lg border-2 transition-all duration-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                      isDarkMode
                        ? 'bg-gray-700 border-gray-600 text-white focus:bg-gray-600'
                        : 'bg-white border-gray-300 text-gray-900 focus:bg-gray-50'
                    }`}
                  />
                </div>
              </div>
              
              {/* End Date */}
              <div className="space-y-2">
                <label className={`text-sm font-medium ${textSecondaryClass} block`}>
                  End Date
                </label>
                <div className="relative">
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className={`w-full px-4 py-3 rounded-lg border-2 transition-all duration-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                      isDarkMode
                        ? 'bg-gray-700 border-gray-600 text-white focus:bg-gray-600'
                        : 'bg-white border-gray-300 text-gray-900 focus:bg-gray-50'
                    }`}
                  />
                </div>
              </div>
              
              {/* Apply Button */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-transparent block">Apply</label>
                <button
                  onClick={handleApplyCustomDates}
                  disabled={!customStartDate || !customEndDate}
                  className={`w-full px-6 py-3 rounded-lg font-medium transition-all duration-200 flex items-center justify-center space-x-2 ${
                    hasUnappliedChanges
                      ? 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white shadow-lg transform hover:scale-105 animate-pulse'
                      : !customStartDate || !customEndDate
                      ? isDarkMode
                        ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                        : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : isDarkMode
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}
                >
                  <Check className="h-4 w-4" />
                  <span>
                    {hasUnappliedChanges ? 'Apply Changes' : 'Applied'}
                  </span>
                </button>
              </div>
            </div>
            
            {/* Date Range Summary */}
            {customStartDate && customEndDate && (
              <div className={`mt-4 p-3 rounded-lg ${
                isDarkMode ? 'bg-gray-700/50' : 'bg-blue-100/50'
              }`}>
                <p className={`text-sm ${textSecondaryClass}`}>
                  Selected range: <span className={`font-medium ${textClass}`}>
                    {new Date(customStartDate).toLocaleDateString()} - {new Date(customEndDate).toLocaleDateString()}
                  </span>
                  {appliedCustomDates.start && appliedCustomDates.end && (
                    customStartDate === appliedCustomDates.start && customEndDate === appliedCustomDates.end
                      ? <span className={`ml-2 text-green-600 ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>✓ Applied</span>
                      : <span className={`ml-2 text-orange-600 ${isDarkMode ? 'text-orange-400' : 'text-orange-600'}`}>⚠ Click Apply to update</span>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Machine Status */}
      <div className={`flex items-center px-3 py-1 rounded-md ${
        machineColor === 'green'
          ? isDarkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-800' 
          : machineColor === 'red'
          ? isDarkMode ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-800'
          : machineColor === 'orange'
          ? isDarkMode ? 'bg-orange-900/30 text-orange-400' : 'bg-orange-100 text-orange-800'
          : isDarkMode ? 'bg-gray-900/30 text-gray-400' : 'bg-gray-100 text-gray-800'
      }`}>
        {machineColor === 'green' ? (
          <Zap className="h-4 w-4 mr-1" />
        ) : (
          <ZapOff className="h-4 w-4 mr-1" />
        )}
        <span className="text-sm">
          {machineStatus.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
        </span>
      </div>

      {/* Day Navigation */}
      {data.length > 1 && (
        <div className={`flex items-center justify-between rounded-lg p-3 border ${cardBgClass} ${cardBorderClass}`}>
          <button
            onClick={() => setSelectedDayIndex(Math.max(0, selectedDayIndex - 1))}
            disabled={selectedDayIndex === 0}
            className={`p-1 ${textSecondaryClass} hover:${textClass} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          
          <div className="text-center">
            <h3 className={`text-lg font-semibold ${textClass}`}>
              {format(parseISO(currentDay.date), 'EEEE, MMMM dd, yyyy')}
            </h3>
            <p className={`text-sm ${textSecondaryClass}`}>
              Total: {currentDay.hours.reduce((sum, h) => sum + h.unitsProduced, 0)} units • 
              Defects: {currentDay.hours.reduce((sum, h) => sum + h.defectiveUnits, 0)}
            </p>
          </div>
          
          <button
            onClick={() => setSelectedDayIndex(Math.min(data.length - 1, selectedDayIndex + 1))}
            disabled={selectedDayIndex === data.length - 1}
            className={`p-1 ${textSecondaryClass} hover:${textClass} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Compact Horizontal Timeline */}
      <div className={`rounded-lg border p-4 ${cardBgClass} ${cardBorderClass}`}>
        {/* Time Labels */}
        <div className={`flex mb-2 text-xs ${textSecondaryClass}`}>
          {currentDay.hours.map((hour) => (
            <div key={hour.hour} className="flex-1 text-center min-w-0">
              {formatTime(hour.hour)}
            </div>
          ))}
        </div>

        {/* Production Blocks */}
        <div className="flex gap-1 mb-3">
          {currentDay.hours.map((hour) => {
            const hasUnclassifiedStoppage = hour.stoppages.some(s => s.reason === 'unclassified');
            
            return (
              <div
                key={hour.hour}
                className="flex-1 relative group cursor-pointer min-w-0"
                onClick={() => setSelectedHour({ hour, date: currentDay.date })}
              >
                <div className={`h-12 rounded transition-all duration-200 group-hover:scale-105 border relative overflow-hidden ${
                  hasUnclassifiedStoppage ? isDarkMode ? 'border-red-500 border-2' : 'border-red-500 border-2' : `${cardBorderClass}`
                }`}>
                  {(() => {
                    const runningMinutes = hour.runningMinutes || 0;
                    const stoppageMinutes = hour.stoppageMinutes || 0;
                    const inactiveMinutes = 60 - runningMinutes - stoppageMinutes;
                    
                    return (
                      <>
                        <div
                          className="bg-green-500" 
                          style={{ 
                            width: `${((runningMinutes || 0) / 60) * 100}%`,
                            height: '100%',
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            opacity: 0.8
                          }}
                        />
                        
                        <div
                          className={`${hasUnclassifiedStoppage ? 'bg-red-600 animate-pulse' : 'bg-red-500'}`}
                          style={{ 
                            width: `${((stoppageMinutes || 0) / 60) * 100}%`,
                            height: '100%',
                            position: 'absolute',
                            left: `${((runningMinutes || 0) / 60) * 100}%`,
                            top: 0,
                            opacity: hasUnclassifiedStoppage ? 1 : 0.8
                          }}
                        />
                        
                        <div
                          className="bg-gray-500" 
                          style={{ 
                            width: `${((inactiveMinutes || 0) / 60) * 100}%`,
                            height: '100%',
                            position: 'absolute',
                            left: `${((runningMinutes + stoppageMinutes) / 60) * 100}%`,
                            top: 0,
                            opacity: 0.4
                          }}
                        />
                      </>
                    );
                  })()}
                  
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className={`text-xs font-bold text-white bg-black bg-opacity-60 px-1 rounded`}>
                      {hour.unitsProduced}
                    </span>
                  </div>

                  <div className="absolute top-0 left-0 right-0 flex justify-between p-0.5">
                    {hour.operator && (
                      <div className="w-2 h-2 bg-blue-400 rounded-full" title="Operator assigned" />
                    )}
                    
                    {hour.defectiveUnits > 0 && (
                      <div className="w-2 h-2 bg-red-400 rounded-full" title={`${hour.defectiveUnits} defects`} />
                    )}
                  </div>

                  <div className="absolute bottom-0 left-0 right-0 flex justify-between p-0.5">
                    {hour.mold && (
                      <div className="w-2 h-2 bg-purple-400 rounded-full" title="Mold assigned" />
                    )}
                    
                    {hour.stoppages.length > 0 && (
                      <div className={`w-2 h-2 rounded-full ${
                        hasUnclassifiedStoppage ? 'bg-red-600 animate-pulse' : 'bg-red-600'
                      }`} title={`${hour.stoppages.length} stoppages`} />
                    )}
                  </div>

                  {hasUnclassifiedStoppage && (
                    <div className={`absolute inset-0 animate-pulse border-2 rounded ${
                      isDarkMode ? 'bg-red-600 bg-opacity-20 border-red-500' : 'bg-red-200 border-red-500'
                    }`}>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <AlertTriangle className={`h-4 w-4 animate-bounce ${isDarkMode ? 'text-red-400' : 'text-red-600'}`} />
                      </div>
                    </div>
                  )}
                </div>

                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                  <div className={`rounded-lg px-3 py-2 whitespace-nowrap border shadow-lg ${
                    isDarkMode ? 'bg-gray-900 text-white border-gray-600' : 'bg-white text-gray-900 border-gray-200'
                  }`}>
                    <div className="font-medium">{formatTime(hour.hour)}</div>
                    <div>Units: <span className={`${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>{hour.unitsProduced}</span></div>
                    {hour.defectiveUnits > 0 && (
                      <div>Defects: <span className={`${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{hour.defectiveUnits}</span></div>
                    )}
                    <div>Running: <span className={`${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>{hour.runningMinutes || 0}m</span></div>
                    <div>Stoppage: <span className={`${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{hour.stoppageMinutes || 0}m</span></div>
                    <div>Inactive: <span className={textSecondaryClass}>{60 - (hour.runningMinutes || 0) - (hour.stoppageMinutes || 0)}m</span></div>
                    {hour.operator && (
                      <div>Op: <span className={`${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>{hour.operator.username}</span></div>
                    )}
                    {hour.mold && (
                      <div>Mold: <span className={`${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>{hour.mold.name}</span></div>
                    )}
                    <div>Status: <span className="capitalize">{hour.status.replace('_', ' ')}</span></div>
                    {hour.stoppages.length > 0 && (
                      <div className="mt-1">
                        {hour.stoppages.map((stoppage, idx) => (
                          <div key={idx} className={`${isDarkMode ? 'text-red-300' : 'text-red-600'}`}>
                            {stoppage.reason === 'unclassified' ? 'Unclassified' : stoppage.reason}: 
                            {stoppage.duration} min
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Summary Stats */}
        <div className={`grid grid-cols-4 gap-4 pt-3 border-t ${cardBorderClass}`}>
          <div className="text-center">
            <div className={`text-lg font-bold ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>
              {currentDay.hours.reduce((sum, h) => sum + h.unitsProduced, 0)}
            </div>
            <div className={`text-xs ${textSecondaryClass}`}>Total Units</div>
          </div>
          <div className="text-center">
            <div className={`text-lg font-bold ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
              {currentDay.hours.reduce((sum, h) => sum + h.defectiveUnits, 0)}
            </div>
            <div className={`text-xs ${textSecondaryClass}`}>Defects</div>
          </div>
          <div className="text-center">
            <div className={`text-lg font-bold ${isDarkMode ? 'text-yellow-400' : 'text-amber-600'}`}>
              {Math.round(currentDay.hours.reduce((sum, h) => sum + (h.runningMinutes || 0), 0) / 60 * 10) / 10}h
            </div>
            <div className={`text-xs ${textSecondaryClass}`}>Running</div>
          </div>
          <div className="text-center">
            <div className={`text-lg font-bold ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
              {currentDay.hours.reduce((sum, h) => sum + h.stoppages.length, 0)}
            </div>
            <div className={`text-xs ${textSecondaryClass}`}>Stoppages</div>
          </div>
        </div>
      </div>

      {/* Week/Month Overview */}
      {timeframe !== 'today' && data.length > 1 && (
        <div className={`rounded-lg border p-4 ${cardBgClass} ${cardBorderClass}`}>
          <h4 className={`text-sm font-medium ${textClass} mb-3`}>
            {timeframe === 'week' ? 'Week' : 'Month'} Overview
          </h4>
          <div className="space-y-2">
            {data.map((day, index) => (
              <div 
                key={day.date} 
                className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                  index === selectedDayIndex 
                    ? isDarkMode 
                      ? 'bg-blue-600/20 border border-blue-500/30' 
                      : 'bg-blue-100 border border-blue-300'
                    : isDarkMode 
                      ? 'hover:bg-gray-700' 
                      : 'hover:bg-gray-100'
                }`}
                onClick={() => setSelectedDayIndex(index)}
              >
                <div className={`text-sm ${textClass}`}>
                  {format(parseISO(day.date), 'MMM dd')}
                  {isToday(parseISO(day.date)) && (
                    <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
                      isDarkMode ? 'bg-blue-600 text-white' : 'bg-blue-100 text-blue-800'
                    }`}>Today</span>
                  )}
                </div>
                <div className="flex items-center space-x-4 text-xs">
                  <span className={isDarkMode ? 'text-green-400' : 'text-green-600'}>
                    {day.hours.reduce((sum, h) => sum + h.unitsProduced, 0)} units
                  </span>
                  <span className={isDarkMode ? 'text-red-400' : 'text-red-600'}>
                    {day.hours.reduce((sum, h) => sum + h.defectiveUnits, 0)} defects
                  </span>
                  <span className={isDarkMode ? 'text-yellow-400' : 'text-amber-600'}>
                    {Math.round(day.hours.reduce((sum, h) => sum + (h.runningMinutes || 0), 0) / 60 * 10) / 10}h running
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Production Modal */}
      {selectedHour && (
        <ProductionModal
          key={`${selectedHour.date}-${selectedHour.hour.hour}`}
          isOpen={true}
          onClose={() => setSelectedHour(null)}
          hour={selectedHour.hour}
          date={selectedHour.date}
          machineId={machineId}
          onAddStoppage={onAddStoppage}
          onUpdateProduction={onUpdateProduction}
          availableOperators={availableOperators}
          availableMolds={availableMolds}
          shifts={shifts}
        />
      )}
    </div>
  );
};

export default ProductionTimeline;
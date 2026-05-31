import React, { useState, useEffect, useContext } from 'react';
import { useAuth } from '../context/AuthContext';
import { Department, Machine } from '../types';
import apiService from '../services/api';
import { 
  FileText, 
  Download, 
  Mail, 
  AlertTriangle,
  Filter,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { ThemeContext } from '../App';

interface Report {
  _id: string;
  type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  period: {
    start: string;
    end: string;
  };
  departmentId?: Department;
  machineId?: Machine;
  metrics: {
    oee: number;
    mttr: number;
    mtbf: number;
    availability: number;
    quality: number;
    performance: number;
    totalUnitsProduced: number;
    totalDefectiveUnits: number;
    totalRunningMinutes: number;
    totalStoppageMinutes: number;
    totalStoppages: number;
  };
  shiftData: Array<{
    shiftName: string;
    startTime: string;
    endTime: string;
    metrics: {
      oee: number;
      unitsProduced: number;
      defectiveUnits: number;
      runningMinutes: number;
      stoppageMinutes: number;
    };
  }>;
  generatedBy: {
    username: string;
  };
  emailSent: boolean;
  emailSentAt?: string;
  createdAt: string;
}

const Reports: React.FC = () => {
  const { isAdmin } = useAuth();
  const { isDarkMode } = useContext(ThemeContext);
  const [reports, setReports] = useState<Report[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [filters, setFilters] = useState({
    type: '',
    departmentId: '',
    machineId: ''
  });
  const [reportForm, setReportForm] = useState({
    type: 'daily' as 'daily' | 'weekly' | 'monthly' | 'yearly',
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    departmentId: '',
    machineId: ''
  });

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

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    fetchReports();
  }, [filters]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [reportsData, departmentsData, machinesData] = await Promise.all([
        apiService.getReports(),
        apiService.getDepartments(),
        apiService.getMachines()
      ]);
      
      setReports(reportsData);
      setDepartments(departmentsData);
      setMachines(machinesData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch data';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const fetchReports = async () => {
    try {
      const reportsData = await apiService.getReports(filters);
      setReports(reportsData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch reports';
      toast.error(message);
    }
  };

  const handleGenerateReport = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!reportForm.startDate || !reportForm.endDate) {
      toast.error('Please select both start and end dates');
      return;
    }
    
    if (new Date(reportForm.startDate) > new Date(reportForm.endDate)) {
      toast.error('Start date cannot be after end date');
      return;
    }
    
    try {
      setGenerating(true);
      const report = await apiService.generateReport(reportForm);
      setReports([report, ...reports]);
      toast.success('Report generated successfully');
      fetchReports();
      
      // Reset form
      setReportForm({
        type: 'daily',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        departmentId: '',
        machineId: ''
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate report';
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const handleEmailReport = async (reportId: string) => {
    try {
      await apiService.emailReport(reportId);
      setReports(reports.map(r => 
        r._id === reportId 
          ? { ...r, emailSent: true, emailSentAt: new Date().toISOString() }
          : r
      ));
      toast.success('Report emailed successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to email report';
      toast.error(message);
    }
  };

  const handleDownloadPDF = async (reportId: string, reportType: string, startDate: string) => {
    try {
      await apiService.downloadReportPDF(reportId, reportType, startDate);
      toast.success('PDF downloaded successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to download PDF';
      toast.error(message);
    }
  };

  const handleDeleteReport = async (reportId: string) => {
    if (!confirm('Are you sure you want to delete this report? This action cannot be undone.')) {
      return;
    }

    try {
      await apiService.request(`/reports/${reportId}`, { method: 'DELETE' });
      
      setReports(reports.filter(r => r._id !== reportId));
      toast.success('Report deleted successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete report';
      toast.error(message);
    }
  };

  const getReportTypeColor = (type: string) => {
    switch (type) {
      case 'daily': return isDarkMode ? 'bg-blue-900/50 text-blue-400' : 'bg-blue-100 text-blue-800';
      case 'weekly': return isDarkMode ? 'bg-green-900/50 text-green-400' : 'bg-green-100 text-green-800';
      case 'monthly': return isDarkMode ? 'bg-yellow-900/50 text-yellow-400' : 'bg-yellow-100 text-yellow-800';
      case 'yearly': return isDarkMode ? 'bg-purple-900/50 text-purple-400' : 'bg-purple-100 text-purple-800';
      default: return isDarkMode ? 'bg-gray-900/50 text-gray-400' : 'bg-gray-100 text-gray-800';
    }
  };

  if (!isAdmin) {
    return (
      <div className={`${isDarkMode ? 'bg-red-900/50 border-red-500' : 'bg-red-100 border-red-300'} border px-4 py-3 rounded-md`}>
        <div className="flex items-center">
          <AlertTriangle className="h-4 w-4 mr-2" />
          <span className={textClass}>Access denied. Admin privileges required.</span>
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
      <div className="flex items-center space-x-4">
        <FileText className={`h-8 w-8 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
        <div>
          <h1 className={`text-2xl font-bold ${textClass}`}>Production Reports</h1>
          <p className={textSecondaryClass}>Generate and manage OEE, MTTR, and MTBF reports</p>
        </div>
      </div>

      {/* Generate Report Form */}
      <div className={`rounded-lg border p-6 ${cardBgClass} ${cardBorderClass}`}>
        <h2 className={`text-lg font-semibold ${textClass} mb-4`}>Generate New Report</h2>
        
        <form onSubmit={handleGenerateReport} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                Report Type
              </label>
              <select
                value={reportForm.type}
                onChange={(e) => setReportForm({...reportForm, type: e.target.value as any})}
                className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>

            <div>
              <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                Start Date
              </label>
              <input
                type="date"
                value={reportForm.startDate}
                onChange={(e) => setReportForm({...reportForm, startDate: e.target.value})}
                className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                End Date
              </label>
              <input
                type="date"
                value={reportForm.endDate}
                onChange={(e) => setReportForm({...reportForm, endDate: e.target.value})}
                className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                Department (Optional)
              </label>
              <select
                value={reportForm.departmentId}
                onChange={(e) => setReportForm({...reportForm, departmentId: e.target.value})}
                className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">All Departments</option>
                {departments.map((dept) => (
                  <option key={dept._id} value={dept._id}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={`block text-sm font-medium mb-2 ${textSecondaryClass}`}>
                Machine (Optional)
              </label>
              <select
                value={reportForm.machineId}
                onChange={(e) => setReportForm({...reportForm, machineId: e.target.value})}
                className={`w-full ${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">All Machines</option>
                {machines.map((machine) => (
                  <option key={machine._id} value={machine._id}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={generating}
              className={`flex items-center space-x-2 px-4 py-2 ${buttonPrimaryClass} text-white rounded-md disabled:opacity-50 transition-colors`}
            >
              {generating ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              <span>{generating ? 'Generating...' : 'Generate Report'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Filters */}
      <div className={`rounded-lg border p-4 ${cardBgClass} ${cardBorderClass}`}>
        <div className="flex items-center space-x-4">
          <Filter className={`h-5 w-5 ${textSecondaryClass}`} />
          <div className="flex space-x-4 flex-1">
            <select
              value={filters.type}
              onChange={(e) => setFilters({...filters, type: e.target.value})}
              className={`${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
            >
              <option value="">All Types</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>

            <select
              value={filters.departmentId}
              onChange={(e) => setFilters({...filters, departmentId: e.target.value})}
              className={`${inputBgClass} border ${inputBorderClass} rounded-md px-3 py-2 ${textClass} text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
            >
              <option value="">All Departments</option>
              {departments.map((dept) => (
                <option key={dept._id} value={dept._id}>
                  {dept.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Reports List */}
      <div className={`rounded-lg border ${cardBgClass} ${cardBorderClass}`}>
        <div className={`p-6 border-b ${cardBorderClass}`}>
          <h2 className={`text-lg font-semibold ${textClass}`}>Generated Reports</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className={tableHeaderClass}>
              <tr>
                <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Report
                </th>
                <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Period
                </th>
                <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Key Metrics
                </th>
                <th className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Generated
                </th>
                <th className={`px-6 py-3 text-right text-xs font-medium uppercase tracking-wider ${textSecondaryClass}`}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDarkMode ? 'divide-gray-700' : 'divide-gray-200'}`}>
              {reports.map((report) => (
                <tr key={report._id} className={tableRowHoverClass}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <FileText className={`h-8 w-8 ${isDarkMode ? 'text-blue-400' : 'text-blue-500'}`} />
                      </div>
                      <div className="ml-4">
                        <div className="flex items-center space-x-2">
                          <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getReportTypeColor(report.type)}`}>
                            {report.type.toUpperCase()}
                          </span>
                          {report.emailSent && (
                            <span className={`px-2 py-1 text-xs rounded-full ${
                              isDarkMode ? 'bg-green-900/50 text-green-400' : 'bg-green-100 text-green-800'
                            }`}>
                              Emailed
                            </span>
                          )}
                        </div>
                        <div className={`text-sm ${textSecondaryClass} mt-1`}>
                          {report.departmentId?.name || 'All Departments'} • {report.machineId?.name || 'All Machines'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className={`text-sm ${textClass}`}>
                      {new Date(report.period.start).toLocaleDateString()} - {new Date(report.period.end).toLocaleDateString()}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="text-center">
                        <div className={`font-semibold ${isDarkMode ? 'text-yellow-400' : 'text-yellow-600'}`}>
                          {report.metrics.oee}%
                        </div>
                        <div className={textSecondaryClass}>OEE</div>
                      </div>
                      <div className="text-center">
                        <div className={`font-semibold ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                          {report.metrics.mtbf}m
                        </div>
                        <div className={textSecondaryClass}>MTBF</div>
                      </div>
                      <div className="text-center">
                        <div className={`font-semibold ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
                          {report.metrics.mttr}m
                        </div>
                        <div className={textSecondaryClass}>MTTR</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className={`text-sm ${textClass}`}>
                      {new Date(report.createdAt).toLocaleDateString()}
                    </div>
                    <div className={`text-xs ${textSecondaryClass}`}>
                      by {report.generatedBy.username ? report.generatedBy.username : 'System'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end space-x-2">
                      <button
                        onClick={() => handleDownloadPDF(report._id, report.type, report.period.start.split('T')[0])}
                        className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                          isDarkMode 
                            ? 'text-blue-400 hover:text-blue-300' 
                            : 'text-blue-600 hover:text-blue-800'
                        }`}
                        title="Download PDF"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleEmailReport(report._id)}
                        className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                          isDarkMode 
                            ? 'text-green-400 hover:text-green-300' 
                            : 'text-green-600 hover:text-green-800'
                        }`}
                        title="Email Report"
                      >
                        <Mail className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteReport(report._id)}
                        className={`p-1 rounded-md hover:${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} ${
                          isDarkMode 
                            ? 'text-red-400 hover:text-red-300' 
                            : 'text-red-600 hover:text-red-800'
                        }`}
                        title="Delete Report"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {reports.length === 0 && (
            <div className="text-center py-12">
              <FileText className={`h-12 w-12 ${textSecondaryClass} mx-auto mb-4`} />
              <h3 className={`text-lg font-medium ${textSecondaryClass} mb-2`}>No reports found</h3>
              <p className={textSecondaryClass}>Generate your first report to get started</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Reports;
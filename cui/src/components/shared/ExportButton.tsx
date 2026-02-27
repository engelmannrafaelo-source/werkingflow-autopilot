import { useState } from 'react';

interface ExportButtonProps {
  data: any[];
  filename: string;
  disabled?: boolean;
}

/**
 * Reusable export component for CSV/JSON exports
 *
 * Features:
 * - CSV export with proper escaping (quotes, commas, newlines)
 * - JSON export with pretty-printing
 * - Dropdown UI for format selection
 * - Automatic filename with timestamp
 * - Browser download trigger
 *
 * Usage:
 * <ExportButton data={users} filename="users" />
 * // Generates: users-2026-02-27.csv or users-2026-02-27.json
 */
export default function ExportButton({ data, filename, disabled = false }: ExportButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false);

  // Get current date for filename
  const getTimestamp = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Escape CSV values (handle quotes, commas, newlines)
  const escapeCSV = (val: any): string => {
    if (val === null || val === undefined) {
      return '';
    }
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Trigger browser download
  const downloadFile = (content: string, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Export as CSV
  const exportCSV = () => {
    if (!data || data.length === 0) {
      alert('No data to export');
      return;
    }

    // Extract headers from first object
    const headers = Object.keys(data[0]);

    // Build CSV rows
    const rows = data.map(row =>
      headers.map(header => escapeCSV(row[header])).join(',')
    );

    // Combine headers + rows
    const csv = [headers.join(','), ...rows].join('\n');

    // Download
    const timestamp = getTimestamp();
    downloadFile(csv, `${filename}-${timestamp}.csv`, 'text/csv');
    setShowDropdown(false);
  };

  // Export as JSON
  const exportJSON = () => {
    if (!data || data.length === 0) {
      alert('No data to export');
      return;
    }

    // Pretty-print with 2-space indent
    const json = JSON.stringify(data, null, 2);

    // Download
    const timestamp = getTimestamp();
    downloadFile(json, `${filename}-${timestamp}.json`, 'application/json');
    setShowDropdown(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={disabled || !data || data.length === 0}
        style={{
          padding: '4px 10px',
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
          cursor: disabled || !data || data.length === 0 ? 'not-allowed' : 'pointer',
          background: 'var(--tn-green)',
          border: 'none',
          color: '#fff',
          opacity: disabled || !data || data.length === 0 ? 0.5 : 1,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        Export {showDropdown ? '▴' : '▾'}
      </button>

      {/* Dropdown Menu */}
      {showDropdown && !disabled && data && data.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'var(--tn-bg-dark)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 1000,
            minWidth: 120,
          }}
        >
          <button
            onClick={exportCSV}
            style={{
              width: '100%',
              padding: '6px 12px',
              fontSize: 10,
              fontWeight: 600,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'var(--tn-text)',
              cursor: 'pointer',
              borderBottom: '1px solid var(--tn-border)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(122,162,247,0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            📄 Export CSV
          </button>
          <button
            onClick={exportJSON}
            style={{
              width: '100%',
              padding: '6px 12px',
              fontSize: 10,
              fontWeight: 600,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'var(--tn-text)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(122,162,247,0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            📋 Export JSON
          </button>
        </div>
      )}

      {/* Click outside to close dropdown */}
      {showDropdown && (
        <div
          onClick={() => setShowDropdown(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 999,
          }}
        />
      )}
    </div>
  );
}

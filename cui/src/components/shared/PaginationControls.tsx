import React from 'react';

interface PaginationControlsProps {
  total: number;
  offset: number;
  limit: number;
  onPageChange: (newOffset: number) => void;
  onPageSizeChange: (newLimit: number) => void;
  pageSizeOptions?: number[];
}

export default function PaginationControls({
  total,
  offset,
  limit,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
}: PaginationControlsProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasMore = offset + limit < total;
  const hasPrev = offset > 0;

  const handlePrevious = () => {
    if (hasPrev) {
      onPageChange(Math.max(0, offset - limit));
    }
  };

  const handleNext = () => {
    if (hasMore) {
      onPageChange(offset + limit);
    }
  };

  const handleFirst = () => {
    if (hasPrev) {
      onPageChange(0);
    }
  };

  const handleLast = () => {
    if (hasMore) {
      const lastPageOffset = (totalPages - 1) * limit;
      onPageChange(lastPageOffset);
    }
  };

  const startItem = Math.min(offset + 1, total);
  const endItem = Math.min(offset + limit, total);

  const buttonStyle = (disabled: boolean): React.CSSProperties => ({
    padding: '3px 8px',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? 'var(--tn-bg)' : 'var(--tn-bg)',
    border: '1px solid var(--tn-border)',
    color: disabled ? 'var(--tn-text-muted)' : 'var(--tn-text)',
    opacity: disabled ? 0.5 : 1,
  });

  const selectStyle: React.CSSProperties = {
    padding: '3px 6px',
    borderRadius: 3,
    fontSize: 10,
    background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)',
    color: 'var(--tn-text)',
    outline: 'none',
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 0',
        fontSize: 10,
        color: 'var(--tn-text-muted)',
      }}
    >
      {/* Items info */}
      <div style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
        Showing {startItem}-{endItem} of {total}
      </div>

      <div style={{ flex: 1 }} />

      {/* Page size selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>Per page:</span>
        <select
          value={limit}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          style={selectStyle}
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      {/* Navigation buttons */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={handleFirst} disabled={!hasPrev} style={buttonStyle(!hasPrev)}>
          ««
        </button>
        <button onClick={handlePrevious} disabled={!hasPrev} style={buttonStyle(!hasPrev)}>
          «
        </button>
        <div
          style={{
            padding: '3px 10px',
            fontSize: 10,
            color: 'var(--tn-text)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          Page {currentPage} of {totalPages}
        </div>
        <button onClick={handleNext} disabled={!hasMore} style={buttonStyle(!hasMore)}>
          »
        </button>
        <button onClick={handleLast} disabled={!hasMore} style={buttonStyle(!hasMore)}>
          »»
        </button>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback } from 'react';

export interface FilterOption {
  label: string;
  value: string;
}

export interface FilterConfig {
  key: string;
  label: string;
  options: FilterOption[];
  placeholder?: string;
}

export interface TableSearchProps {
  onSearch: (query: string, filters: Record<string, string>) => void;
  placeholder?: string;
  filters?: FilterConfig[];
  debounceMs?: number;
  initialQuery?: string;
  initialFilters?: Record<string, string>;
}

export default function TableSearch({
  onSearch,
  placeholder = 'Search...',
  filters = [],
  debounceMs = 300,
  initialQuery = '',
  initialFilters = {},
}: TableSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>(initialFilters);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  // Call onSearch when debounced query or filters change
  useEffect(() => {
    onSearch(debouncedQuery, activeFilters);
  }, [debouncedQuery, activeFilters, onSearch]);

  const handleClear = useCallback(() => {
    setQuery('');
    setActiveFilters({});
  }, []);

  const handleFilterChange = useCallback((key: string, value: string) => {
    setActiveFilters(prev => {
      if (value === '') {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const hasActiveFilters = query !== '' || Object.keys(activeFilters).length > 0;

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px',
    paddingRight: query ? '24px' : '8px', // Space for clear button
    borderRadius: 3,
    fontSize: 11,
    background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)',
    color: 'var(--tn-text)',
    outline: 'none',
    width: '100%',
  };

  const selectStyle: React.CSSProperties = {
    padding: '5px 8px',
    borderRadius: 3,
    fontSize: 11,
    background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)',
    color: 'var(--tn-text)',
    outline: 'none',
    cursor: 'pointer',
    minWidth: 100,
  };

  const clearButtonStyle: React.CSSProperties = {
    position: 'absolute',
    right: 4,
    top: '50%',
    transform: 'translateY(-50%)',
    padding: '2px 6px',
    background: 'transparent',
    border: 'none',
    color: 'var(--tn-text-muted)',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {/* Search Input */}
      <div style={{ position: 'relative', minWidth: 180 }}>
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--tn-text-muted)',
            fontSize: 12,
            pointerEvents: 'none',
          }}
        >
          🔍
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          style={{
            ...inputStyle,
            paddingLeft: 28, // Space for search icon
          }}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            style={clearButtonStyle}
            title="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* Filter Dropdowns */}
      {filters.map((filter) => (
        <select
          key={filter.key}
          value={activeFilters[filter.key] || ''}
          onChange={(e) => handleFilterChange(filter.key, e.target.value)}
          style={selectStyle}
          title={filter.label}
        >
          <option value="">{filter.placeholder || `All ${filter.label}`}</option>
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ))}

      {/* Clear All Button */}
      {hasActiveFilters && (
        <button
          onClick={handleClear}
          style={{
            padding: '3px 8px',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            cursor: 'pointer',
            background: 'rgba(247,118,142,0.15)',
            border: '1px solid rgba(247,118,142,0.3)',
            color: 'var(--tn-red)',
          }}
          title="Clear all filters"
        >
          Clear All
        </button>
      )}
    </div>
  );
}

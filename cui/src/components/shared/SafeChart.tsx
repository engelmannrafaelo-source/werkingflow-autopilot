import { ReactElement, useEffect, useRef, useState } from 'react';
import { ResponsiveContainer } from 'recharts';

interface Props {
  children: ReactElement;
  height?: number | string;
  width?: number | string;
}

// Wraps recharts ResponsiveContainer with a ResizeObserver gate so the chart only
// mounts when its container has nonzero size. Prevents recharts from spamming the
// "width and height of chart should be greater than 0" warning when a tab is in a
// hidden/collapsed FlexLayout panel.
export function SafeChart({ children, height = '100%', width = '100%' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasSize, setHasSize] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const { width: w, height: h } = entry.contentRect;
      setHasSize(w > 0 && h > 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ width, height }}>
      {hasSize && (
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}

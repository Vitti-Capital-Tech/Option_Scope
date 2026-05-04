import { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

const CHART_OPTIONS = {
  layout: {
    background: { color: '#0a0d12' },
    textColor: '#7d8590',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: 12,
  },
  grid: {
    vertLines: { color: '#161c24' },
    horzLines: { color: '#161c24' },
  },
  crosshair: {
    mode: 1,
    vertLine: { color: '#3d444d', style: 1 },
    horzLine: { color: '#3d444d', style: 1 },
  },
  timeScale: {
    borderColor: '#1e2730',
    timeVisible: true,
    secondsVisible: false,
  },
  rightPriceScale: { borderColor: '#1e2730' },
  handleScroll: true,
  handleScale: true,
};

// useChart: manages one lightweight-chart instance in a container div ref
export function useChart(containerRef, visible) {
  const chartRef   = useRef(null);
  const seriesRef  = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...CHART_OPTIONS,
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({
        width:  containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [containerRef]);

  return { chartRef, seriesRef };
}

// addCandleSeries: add a named candlestick series to a chart
export function addCandleSeries(chart, color) {
  return chart.addCandlestickSeries({
    upColor:        color.up,
    downColor:      color.down,
    borderVisible:  false,
    wickUpColor:    color.up,
    wickDownColor:  color.down,
  });
}

import React, { ReactNode, useId, useState } from 'react';
import { useTheme } from '../context/ThemeContext';

interface TooltipProps {
  content: string;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  className?: string;
}

interface CursorPosition {
  x: number;
  y: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'bottom',
  className = ''
}) => {
  const { isDark } = useTheme();
  const tooltipId = useId();
  const [cursorPosition, setCursorPosition] = useState<CursorPosition | null>(null);

  const showTooltip = (position: CursorPosition) => {
    setCursorPosition(position);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLSpanElement>) => {
    showTooltip({ x: event.clientX, y: event.clientY });
  };

  const handleFocus = (event: React.FocusEvent<HTMLSpanElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    showTooltip({
      x: bounds.left + bounds.width / 2,
      y: placement === 'top' ? bounds.top : bounds.bottom
    });
  };

  const handleBlur = (event: React.FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setCursorPosition(null);
    }
  };

  return (
    <span
      className={`chronos-tooltip ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setCursorPosition(null)}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {children}
      {cursorPosition && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`chronos-tooltip-bubble chronos-tooltip-${placement}`}
          data-theme={isDark ? 'dark' : 'light'}
          style={{
            left: cursorPosition.x,
            top: cursorPosition.y
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
};

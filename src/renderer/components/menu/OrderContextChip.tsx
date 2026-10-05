import React from 'react';
import { User } from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import './order-context-chip.css';

export const OrderContextChip = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => {
  const { resolvedTheme } = useTheme();
  const content = <><User size={15} aria-hidden="true" /><span>{children}</span></>;
  const className = `order-context-chip order-context-chip--${resolvedTheme}`;
  return onClick ? <button type="button" className={className} onClick={onClick}>{content}</button>
    : <span className={className}>{content}</span>;
};

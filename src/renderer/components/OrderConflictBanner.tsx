import React, { useState, useEffect } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, CheckCircle, XCircle, RefreshCw, Clock } from 'lucide-react';
import { useI18n } from '../contexts/i18n-context';

interface OrderConflict {
  id: string;
  orderId: string;
  localVersion: number;
  remoteVersion: number;
  conflictType: string;
  createdAt: string;
  localValue?: any;
  remoteValue?: any;
  field?: string;
}

interface OrderConflictBannerProps {
  conflicts: OrderConflict[];
  onResolve: (conflictId: string, strategy: string) => Promise<void>;
  onDismiss?: () => void;
}

export const OrderConflictBanner: React.FC<OrderConflictBannerProps> = ({
  conflicts,
  onResolve,
  onDismiss
}) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const [resolvingConflicts, setResolvingConflicts] = useState<Set<string>>(new Set());

  // Auto-expand when conflicts appear
  useEffect(() => {
    if (conflicts.length > 0) {
      setIsExpanded(true);
    }
  }, [conflicts.length]);

  if (conflicts.length === 0) {
    return null;
  }

  const handleResolve = async (conflictId: string, strategy: string) => {
    setResolvingConflicts(prev => new Set(prev).add(conflictId));
    try {
      await onResolve(conflictId, strategy);
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
    } finally {
      setResolvingConflicts(prev => {
        const next = new Set(prev);
        next.delete(conflictId);
        return next;
      });
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const getConflictDescription = (conflict: OrderConflict): string => {
    const typeDescriptions: Record<string, string> = {
      'status_change': 'Order status was changed',
      'price_update': 'Order total amount was updated',
      'items_modified': 'Order items were modified',
      'customer_info': 'Customer information was updated',
      'payment_status': 'Payment status was changed',
      'driver_assignment': 'Driver assignment was changed',
      'preparation_progress': 'Preparation progress was updated',
      'cancellation': 'Order cancellation status changed'
    };
    const key = conflict.conflictType ?? '';
    return typeDescriptions[key] || (key ? key.replace(/_/g, ' ') : 'Conflict');
  };

  const getConflictColor = (conflictType: string): string => {
    const colorMap: Record<string, string> = {
      'status_change': 'bg-blue-100 text-blue-800',
      'price_update': 'bg-red-100 text-red-800',
      'items_modified': 'bg-purple-100 text-purple-800',
      'customer_info': 'bg-green-100 text-green-800',
      'payment_status': 'bg-orange-100 text-orange-800',
      'driver_assignment': 'bg-cyan-100 text-cyan-800',
      'preparation_progress': 'bg-yellow-100 text-yellow-800',
      'cancellation': 'bg-red-100 text-red-800'
    };
    return colorMap[conflictType] || 'bg-yellow-100 text-yellow-800';
  };

  return null;
};

export default OrderConflictBanner;


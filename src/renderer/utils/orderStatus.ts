export const ORDER_STATUS_BADGE_CLASSES: Record<string, string> = {
  pending: 'bg-(--pos-s-surface-2) text-yellow-800 dark:text-yellow-400 border-(--pos-s-border)',
  confirmed: 'bg-(--pos-s-surface-2) text-blue-800 dark:text-blue-400 border-(--pos-s-border)',
  processing: 'bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-400 border-(--pos-s-border)',
  preparing: 'bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-400 border-(--pos-s-border)',
  ready: 'bg-(--pos-s-surface-2) text-green-800 dark:text-green-400 border-(--pos-s-border)',
  out_for_delivery: 'bg-(--pos-s-surface-2) text-cyan-800 dark:text-cyan-400 border-(--pos-s-border)',
  completed: 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30',
  delivered: 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30',
  cancelled: 'bg-(--pos-s-surface-2) text-red-800 dark:text-red-400 border-(--pos-s-border)',
};

export const getOrderStatusBadgeClasses = (status?: string) => {
  const normalized = (status || '').toLowerCase();
  return ORDER_STATUS_BADGE_CLASSES[normalized] || ORDER_STATUS_BADGE_CLASSES.pending;
};

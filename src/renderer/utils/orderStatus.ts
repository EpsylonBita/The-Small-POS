export const ORDER_STATUS_BADGE_CLASSES: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
  confirmed: 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30',
  processing: 'bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30',
  preparing: 'bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30',
  ready: 'bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30',
  out_for_delivery: 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
  completed: 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30',
  delivered: 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30',
  cancelled: 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30',
};

export const getOrderStatusBadgeClasses = (status?: string) => {
  const normalized = (status || '').toLowerCase();
  return ORDER_STATUS_BADGE_CLASSES[normalized] || ORDER_STATUS_BADGE_CLASSES.pending;
};

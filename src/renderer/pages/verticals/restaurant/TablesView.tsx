import React, { memo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * TablesView - Restaurant Tables Page
 *
 * This view has been deprecated in favor of the integrated Tables tab
 * in the main Dashboard. This component now redirects to the dashboard
 * with the Tables tab active.
 *
 * The Tables functionality is now part of the OrderDashboard component
 * and is module-dependent (requires Tables module to be acquired).
 */
export const TablesView: React.FC = memo(() => {
  const navigate = useNavigate();

  useEffect(() => {
    // Redirect to dashboard - the Tables tab will be shown if Tables module is acquired
    navigate('/', { replace: true });
  }, [navigate]);

  return (
    <div className="h-full flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
});

TablesView.displayName = 'TablesView';

export default TablesView;

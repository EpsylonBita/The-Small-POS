import React, { memo } from 'react';
import TablesPage from '../../TablesPage';

/**
 * TablesView - Restaurant Tables Page
 *
 * Full-featured table management view with:
 * - Grid and floor plan visualization
 * - Real-time table status updates via Supabase
 * - Status management (available → occupied → reserved → cleaning)
 * - Table filtering by status, section, floor
 * - Quick actions for orders and reservations
 *
 * @since 2.3.0 - Now uses dedicated TablesPage component
 */
export const TablesView: React.FC = memo(() => {
  return <TablesPage />;
});

TablesView.displayName = 'TablesView';

export default TablesView;

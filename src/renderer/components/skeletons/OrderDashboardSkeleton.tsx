import React from 'react';

/**
 * OrderDashboardSkeleton - Loading skeleton for OrderDashboard
 * 
 * Displays placeholder UI while orders are loading.
 */
export const OrderDashboardSkeleton: React.FC = () => {
  return (
    <div className="order-dashboard-skeleton" style={{ padding: '20px' }}>
      {/* Header Skeleton */}
      <div style={{ marginBottom: '24px' }}>
        <div
          style={{
            width: '200px',
            height: '32px',
            backgroundColor: '#e0e0e0',
            borderRadius: '4px',
            marginBottom: '16px',
            animation: 'pulse 1.5s ease-in-out infinite'
          }}
        />
        
        {/* Filter Tabs Skeleton */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              style={{
                width: '100px',
                height: '40px',
                backgroundColor: '#e0e0e0',
                borderRadius: '8px',
                animation: 'pulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.1}s`
              }}
            />
          ))}
        </div>
      </div>

      {/* Orders Grid Skeleton */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '16px',
              animation: 'pulse 1.5s ease-in-out infinite',
              animationDelay: `${i * 0.1}s`
            }}
          >
            {/* Order Number */}
            <div
              style={{
                width: '120px',
                height: '24px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '12px'
              }}
            />
            
            {/* Customer Name */}
            <div
              style={{
                width: '160px',
                height: '20px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '8px'
              }}
            />
            
            {/* Order Details */}
            <div
              style={{
                width: '100%',
                height: '60px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '12px'
              }}
            />
            
            {/* Total Amount */}
            <div
              style={{
                width: '80px',
                height: '24px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '12px'
              }}
            />
            
            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <div
                style={{
                  flex: '1',
                  height: '36px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '6px'
                }}
              />
              <div
                style={{
                  flex: '1',
                  height: '36px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '6px'
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Pulse Animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
};


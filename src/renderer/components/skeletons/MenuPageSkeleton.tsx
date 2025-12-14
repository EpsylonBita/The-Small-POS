import React from 'react';

/**
 * MenuPageSkeleton - Loading skeleton for MenuPage
 * 
 * Displays placeholder UI while menu data is loading.
 * Matches the layout of MenuPage for smooth transition.
 */
export const MenuPageSkeleton: React.FC = () => {
  return (
    <div className="menu-page-skeleton" style={{ padding: '20px' }}>
      {/* Header Skeleton */}
      <div style={{ marginBottom: '24px' }}>
        <div 
          className="skeleton-title"
          style={{
            width: '200px',
            height: '32px',
            backgroundColor: '#e0e0e0',
            borderRadius: '4px',
            marginBottom: '16px',
            animation: 'pulse 1.5s ease-in-out infinite'
          }}
        />
        
        {/* Category Tabs Skeleton */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="skeleton-tab"
              style={{
                width: '120px',
                height: '48px',
                backgroundColor: '#e0e0e0',
                borderRadius: '8px',
                animation: 'pulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.1}s`
              }}
            />
          ))}
        </div>

        {/* Subcategory Tabs Skeleton */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="skeleton-subtab"
              style={{
                width: '100px',
                height: '36px',
                backgroundColor: '#e0e0e0',
                borderRadius: '6px',
                animation: 'pulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.1}s`
              }}
            />
          ))}
        </div>
      </div>

      {/* Menu Grid Skeleton */}
      <div 
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '16px'
        }}
      >
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
          <div
            key={i}
            className="skeleton-menu-item"
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '16px',
              animation: 'pulse 1.5s ease-in-out infinite',
              animationDelay: `${i * 0.05}s`
            }}
          >
            {/* Image Skeleton */}
            <div
              style={{
                width: '100%',
                height: '140px',
                backgroundColor: '#e0e0e0',
                borderRadius: '8px',
                marginBottom: '12px'
              }}
            />
            
            {/* Title Skeleton */}
            <div
              style={{
                width: '80%',
                height: '20px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '8px'
              }}
            />
            
            {/* Description Skeleton */}
            <div
              style={{
                width: '100%',
                height: '14px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '4px'
              }}
            />
            <div
              style={{
                width: '60%',
                height: '14px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '12px'
              }}
            />
            
            {/* Price Skeleton */}
            <div
              style={{
                width: '50px',
                height: '24px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px'
              }}
            />
          </div>
        ))}
      </div>

      {/* Inline CSS for pulse animation */}
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

export default MenuPageSkeleton;


import React from 'react';

/**
 * NewOrderPageSkeleton - Loading skeleton for NewOrderPage
 * 
 * Displays placeholder UI while order form is initializing.
 */
export const NewOrderPageSkeleton: React.FC = () => {
  return (
    <div className="new-order-page-skeleton" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', gap: '24px' }}>
        {/* Left Panel - Order Form Skeleton */}
        <div style={{ flex: '1' }}>
          {/* Header */}
          <div
            style={{
              width: '180px',
              height: '32px',
              backgroundColor: '#e0e0e0',
              borderRadius: '4px',
              marginBottom: '24px',
              animation: 'pulse 1.5s ease-in-out infinite'
            }}
          />

          {/* Customer Info Section */}
          <div
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '20px'
            }}
          >
            <div
              style={{
                width: '120px',
                height: '20px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '16px',
                animation: 'pulse 1.5s ease-in-out infinite'
              }}
            />
            
            {/* Input Fields */}
            {[1, 2].map((i) => (
              <div key={i} style={{ marginBottom: '12px' }}>
                <div
                  style={{
                    width: '100%',
                    height: '40px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '6px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
              </div>
            ))}
          </div>

          {/* Order Type Section */}
          <div
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '20px'
            }}
          >
            <div
              style={{
                width: '100px',
                height: '20px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '16px',
                animation: 'pulse 1.5s ease-in-out infinite'
              }}
            />
            
            {/* Order Type Buttons */}
            <div style={{ display: 'flex', gap: '12px' }}>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    flex: '1',
                    height: '48px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '8px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
              ))}
            </div>
          </div>

          {/* Items Section */}
          <div
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '20px'
            }}
          >
            <div
              style={{
                width: '80px',
                height: '20px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '16px',
                animation: 'pulse 1.5s ease-in-out infinite'
              }}
            />
            
            {/* Item Rows */}
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: '12px',
                  marginBottom: '12px',
                  alignItems: 'center'
                }}
              >
                <div
                  style={{
                    flex: '1',
                    height: '40px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '6px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
                <div
                  style={{
                    width: '80px',
                    height: '40px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '6px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Right Panel - Order Summary Skeleton */}
        <div style={{ width: '320px' }}>
          <div
            style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '12px',
              padding: '20px',
              position: 'sticky',
              top: '20px'
            }}
          >
            {/* Summary Title */}
            <div
              style={{
                width: '140px',
                height: '24px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                marginBottom: '20px',
                animation: 'pulse 1.5s ease-in-out infinite'
              }}
            />

            {/* Summary Items */}
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '12px'
                }}
              >
                <div
                  style={{
                    width: '120px',
                    height: '16px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '4px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
                <div
                  style={{
                    width: '60px',
                    height: '16px',
                    backgroundColor: '#e0e0e0',
                    borderRadius: '4px',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 0.1}s`
                  }}
                />
              </div>
            ))}

            {/* Divider */}
            <div
              style={{
                height: '1px',
                backgroundColor: '#e0e0e0',
                margin: '16px 0'
              }}
            />

            {/* Total */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '20px'
              }}
            >
              <div
                style={{
                  width: '80px',
                  height: '24px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '4px',
                  animation: 'pulse 1.5s ease-in-out infinite'
                }}
              />
              <div
                style={{
                  width: '100px',
                  height: '24px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '4px',
                  animation: 'pulse 1.5s ease-in-out infinite'
                }}
              />
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '12px' }}>
              <div
                style={{
                  flex: '1',
                  height: '48px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '8px',
                  animation: 'pulse 1.5s ease-in-out infinite'
                }}
              />
              <div
                style={{
                  flex: '1',
                  height: '48px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '8px',
                  animation: 'pulse 1.5s ease-in-out infinite',
                  animationDelay: '0.1s'
                }}
              />
            </div>
          </div>
        </div>
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

export default NewOrderPageSkeleton;


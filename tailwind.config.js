/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
    "./public/index.html"
  ],
  theme: {
    // Custom breakpoints optimized for POS touchscreens
    screens: {
      'xs': '375px',   // Small phones
      'sm': '640px',   // Large phones / small tablets
      'md': '768px',   // Tablets
      'lg': '1024px',  // Small laptops / large tablets
      'xl': '1280px',  // Desktops
      '2xl': '1536px', // Large desktops
    },
    extend: {
      // Touchscreen-friendly sizing
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
        '26': '6.5rem',
        '30': '7.5rem'
      },
      // Larger touch targets (Apple HIG recommends 44px minimum)
      minHeight: {
        'touch': '44px',
        'touch-lg': '56px',
        'touch-xl': '64px'
      },
      minWidth: {
        'touch': '44px',
        'touch-lg': '56px',
        'touch-xl': '64px'
      },
      // POS-specific colors
      colors: {
        pos: {
          primary: '#2563eb',
          secondary: '#64748b',
          success: '#10b981',
          warning: '#f59e0b',
          error: '#ef4444',
          pending: '#f97316',
          preparing: '#3b82f6',
          ready: '#10b981',
          completed: '#6b7280'
        },
        // Glassmorphism colors
        glass: {
          'primary': 'rgba(59, 130, 246, 0.8)',
          'secondary': 'rgba(100, 116, 139, 0.8)',
          'text': 'rgba(255, 255, 255, 0.9)',
          'bg-primary': 'rgba(255, 255, 255, 0.18)',
          'bg-secondary': 'rgba(255, 255, 255, 0.12)',
          'bg-interactive': 'rgba(255, 255, 255, 0.15)',
          'bg-hover': 'rgba(255, 255, 255, 0.25)',
          'border-primary': 'rgba(255, 255, 255, 0.25)',
          'border-secondary': 'rgba(255, 255, 255, 0.18)',
          'border-interactive': 'rgba(255, 255, 255, 0.22)',
          'border-hover': 'rgba(255, 255, 255, 0.35)'
        }
      },
      // Touch-friendly font sizes
      fontSize: {
        'touch-sm': ['14px', '20px'],
        'touch-base': ['16px', '24px'],
        'touch-lg': ['18px', '28px'],
        'touch-xl': ['20px', '32px']
      },
      // Animation for touch feedback and glassmorphism
      animation: {
        'touch-feedback': 'scale 0.1s ease-in-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glass-float': 'glass-float 6s ease-in-out infinite',
        'glass-shimmer': 'glass-shimmer 2s linear infinite',
        'modal-enter': 'modal-enter 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        'backdrop-enter': 'backdrop-enter 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      },
      keyframes: {
        scale: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(0.95)' }
        },
        'glass-float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        'glass-shimmer': {
          '0%': { backgroundPosition: '-200px 0' },
          '100%': { backgroundPosition: 'calc(200px + 100%) 0' }
        },
        'modal-enter': {
          from: { 
            opacity: '0',
            transform: 'translate(-50%, -50%) scale(0.95)'
          },
          to: { 
            opacity: '1',
            transform: 'translate(-50%, -50%) scale(1)'
          }
        },
        'backdrop-enter': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        }
      },
      // Glassmorphism-specific utilities
      backdropBlur: {
        'xs': '2px',
        'glass': '10px',
        'glass-lg': '12px',
        'glass-xl': '16px'
      },
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(31, 38, 135, 0.37)',
        'glass-lg': '0 12px 40px 0 rgba(31, 38, 135, 0.4)',
        'glass-xl': '0 15px 45px 0 rgba(31, 38, 135, 0.5)',
        'glass-glow': '0 0 20px rgba(59, 130, 246, 0.5), 0 0 40px rgba(59, 130, 246, 0.3)'
      }
    },
  },
  plugins: [],
}
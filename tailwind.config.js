/** @type {import('tailwindcss').Config} */

/**
 * POS palette policy: white / black / grey / yellow.
 *
 * The renderer carries ~1900 legacy "cool brand" color utilities (blue, indigo,
 * sky, cyan, violet, purple, fuchsia, teal, pink). Rather than hand-edit every
 * call site, we remap those color *names* to a neutral zinc ramp here so every
 * `bg-blue-600 text-white` button stays contrast-safe (dark grey, not yellow)
 * while disappearing from the palette. `orange` folds into the `amber` (yellow)
 * family. Yellow is reintroduced deliberately as the accent in the shared style
 * layers and key surfaces. Status hues (green = success, red/rose = error/
 * destructive, amber/yellow = warning) are intentionally left intact to preserve
 * meaning. NOTE: `pink` is remapped to grey (it was decorative-only); `rose` is
 * deliberately NOT remapped — it is the semantic soft-red (e.g. expense amounts).
 */
const neutralRamp = {
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
  950: '#09090b',
};

const amberRamp = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  300: '#fcd34d',
  400: '#fbbf24',
  500: '#f59e0b',
  600: '#d97706',
  700: '#b45309',
  800: '#92400e',
  900: '#78350f',
  950: '#451a03',
};

export default {
  darkMode: 'class',
  // Touchscreen POS: compile `hover:` utilities to `@media (hover: hover)` so a
  // touch-only terminal never shows sticky-hover states after a tap. Mouse-
  // equipped dev machines keep hover; pure touch devices fall back to active/focus.
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
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
        '30': '7.5rem',
      },
      // Larger touch targets (Apple HIG recommends 44px minimum)
      minHeight: {
        'touch': '44px',
        'touch-lg': '56px',
        'touch-xl': '64px',
      },
      minWidth: {
        'touch': '44px',
        'touch-lg': '56px',
        'touch-xl': '64px',
      },
      // POS-specific colors
      colors: {
        // ---- Palette remap: fold cool brand families into neutral grey ----
        // Every `*-blue-*`, `*-purple-*`, etc. now resolves to a contrast-safe
        // zinc ramp, removing brand blue/purple/cyan from the UI without
        // touching call sites. `orange` folds into the yellow (amber) family.
        blue: neutralRamp,
        indigo: neutralRamp,
        sky: neutralRamp,
        cyan: neutralRamp,
        violet: neutralRamp,
        purple: neutralRamp,
        fuchsia: neutralRamp,
        teal: neutralRamp,
        pink: neutralRamp,
        orange: amberRamp,
        pos: {
          primary: '#3f3f46', // neutral (was brand blue)
          secondary: '#64748b',
          success: '#10b981',
          warning: '#f59e0b',
          error: '#ef4444',
          pending: '#f59e0b', // yellow (was orange)
          preparing: '#52525b', // neutral (was blue)
          ready: '#10b981',
          completed: '#6b7280',
        },
        // Glassmorphism colors (neutralised — glass should read white/grey)
        glass: {
          'primary': 'rgba(255, 255, 255, 0.8)',
          'secondary': 'rgba(228, 228, 231, 0.8)',
          'text': 'rgba(255, 255, 255, 0.9)',
          'bg-primary': 'rgba(255, 255, 255, 0.18)',
          'bg-secondary': 'rgba(255, 255, 255, 0.12)',
          'bg-interactive': 'rgba(255, 255, 255, 0.15)',
          'bg-hover': 'rgba(255, 255, 255, 0.25)',
          'border-primary': 'rgba(255, 255, 255, 0.25)',
          'border-secondary': 'rgba(255, 255, 255, 0.18)',
          'border-interactive': 'rgba(255, 255, 255, 0.22)',
          'border-hover': 'rgba(255, 255, 255, 0.35)',
        },
      },
      // Touch-friendly font sizes
      fontSize: {
        'touch-sm': ['14px', '20px'],
        'touch-base': ['16px', '24px'],
        'touch-lg': ['18px', '28px'],
        'touch-xl': ['20px', '32px'],
      },
      // Animation for touch feedback and glassmorphism
      animation: {
        'touch-feedback': 'scale 0.1s ease-in-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glass-float': 'glass-float 6s ease-in-out infinite',
        'glass-shimmer': 'glass-shimmer 2s linear infinite',
        'modal-enter': 'modal-enter 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        'backdrop-enter': 'backdrop-enter 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      },
      keyframes: {
        scale: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(0.95)' },
        },
        'glass-float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'glass-shimmer': {
          '0%': { backgroundPosition: '-200px 0' },
          '100%': { backgroundPosition: 'calc(200px + 100%) 0' },
        },
        'modal-enter': {
          from: {
            opacity: '0',
            transform: 'translate(-50%, -50%) scale(0.95)',
          },
          to: {
            opacity: '1',
            transform: 'translate(-50%, -50%) scale(1)',
          },
        },
        'backdrop-enter': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      // Glassmorphism-specific utilities
      backdropBlur: {
        'xs': '2px',
        'glass': '10px',
        'glass-lg': '12px',
        'glass-xl': '16px',
      },
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.18)',
        'glass-lg': '0 12px 40px 0 rgba(0, 0, 0, 0.22)',
        'glass-xl': '0 15px 45px 0 rgba(0, 0, 0, 0.28)',
        'glass-glow': '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
      },
    },
  },
  plugins: [],
};

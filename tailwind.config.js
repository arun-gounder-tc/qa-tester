/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.625rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },
      colors: {
        surface: {
          DEFAULT: '#ffffff',
          subtle: '#fafafa',
          muted: '#f4f4f5',
        },
        border: {
          DEFAULT: '#e4e4e7',
          subtle: '#f4f4f5',
          strong: '#d4d4d8',
        },
        content: {
          DEFAULT: '#18181b',
          muted: '#52525b',
          subtle: '#71717a',
          disabled: '#a1a1aa',
          inverse: '#ffffff',
        },
        accent: {
          DEFAULT: '#18181b',
          hover: '#27272a',
          subtle: '#f4f4f5',
        },
        brand: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          subtle: '#eef2ff',
        },
        success: {
          DEFAULT: '#10b981',
          subtle: '#ecfdf5',
        },
        warning: {
          DEFAULT: '#f59e0b',
          subtle: '#fffbeb',
        },
        danger: {
          DEFAULT: '#ef4444',
          subtle: '#fef2f2',
        },
        env: {
          dev: '#10b981',
          uat: '#f59e0b',
          staging: '#6366f1',
          prod: '#ef4444',
        },
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.04)',
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.05)',
        md: '0 4px 8px -2px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.04)',
        lg: '0 12px 16px -4px rgb(0 0 0 / 0.08), 0 4px 6px -2px rgb(0 0 0 / 0.04)',
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
    },
  },
  plugins: [],
};

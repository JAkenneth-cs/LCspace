/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#152243', light: '#1e3461', dark: '#0d1a35' },
        gold: { DEFAULT: '#F5C900', dark: '#D4AC00', light: '#FEF9C3' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

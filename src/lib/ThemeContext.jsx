import { createContext, useContext, useState } from 'react'

const ThemeContext = createContext({ theme: 'light', setTheme: () => { } })

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = localStorage.getItem('lc-theme')
      return saved === 'dark' ? 'dark' : 'light'
    } catch { return 'light' }
  })

  function setTheme(t) {
    setThemeState(t)
    try { localStorage.setItem('lc-theme', t) } catch { }
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

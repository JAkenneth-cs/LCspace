import { createContext, useContext, useState, useEffect } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { COLORS } from './theme'

export const LIGHT = {
  type: 'light',
  bg: '#F0F2F8',
  card: '#FFFFFF',
  modal: '#FFFFFF',
  cardBorder: COLORS.gray100,
  text: COLORS.gray900,
  textSub: COLORS.gray500,
  textMuted: COLORS.gray400,
  label: '#8B90A0',
  chipBg: COLORS.gray100,
  chipBorder: COLORS.gray200,
  input: COLORS.gray50,
  inputBorder: COLORS.gray200,
  metaChip: '#EEF0FA',
  filterWrap: '#FFFFFF',
  annoBody: 'rgba(0,0,0,0.5)',
}

export const DARK = {
  type: 'dark',
  bg: '#0B0D1A',
  card: '#1A1C2E',
  modal: '#161826',
  cardBorder: '#252840',
  text: '#F1F5F9',
  textSub: '#94A3B8',
  textMuted: '#64748B',
  label: '#5B6478',
  chipBg: '#252840',
  chipBorder: '#353860',
  input: '#252840',
  inputBorder: '#353860',
  metaChip: '#1E2238',
  filterWrap: '#13152A',
  annoBody: 'rgba(255,255,255,0.45)',
}

const ThemeCtx = createContext({ theme: LIGHT, setTheme: () => { } })

export function ThemeProvider({ children }) {
  const [current, setCurrent] = useState('light')

  useEffect(() => {
    AsyncStorage.getItem('@lcspace_theme').then(v => {
      if (v) setCurrent(v)
    })
  }, [])

  const setTheme = val => {
    setCurrent(val)
    AsyncStorage.setItem('@lcspace_theme', val)
  }

  const themes = { light: LIGHT, dark: DARK }

  return (
    <ThemeCtx.Provider value={{ theme: themes[current] || LIGHT, current, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  )
}

export const useTheme = () => useContext(ThemeCtx)

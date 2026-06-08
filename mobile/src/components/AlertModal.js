import { useState, useCallback, useMemo } from 'react'
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { TriangleAlert, Info, CircleCheckBig } from 'lucide-react-native'

/**
 * useAlert — hook that returns { showAlert, AlertHost }
 *
 * showAlert(title, message, buttons?, opts?)  mirrors Alert.alert API.
 *   buttons: [{ text, style?: 'cancel' | 'destructive', onPress? }]
 *   opts:    { tone?: 'info' | 'success' | 'danger' }  (optional — auto-inferred)
 *
 * AlertHost is rendered once at the root of your screen.
 */
export function useAlert() {
  const [cfg, setCfg] = useState(null)

  const showAlert = useCallback((title, message, buttons = [{ text: 'OK' }], opts = {}) => {
    setCfg({ title, message, buttons, ...opts })
  }, [])

  const AlertHost = useMemo(() => function AlertHost() {
    const { theme } = useTheme()
    const buttons = cfg?.buttons || [{ text: 'OK' }]
    const hasDestructive = buttons.some(b => b.style === 'destructive')
    // Tone: explicit > destructive > info
    const tone = cfg?.tone || (hasDestructive ? 'danger' : 'info')
    const toneMeta = {
      danger:  { bg: '#FEE2E2', color: COLORS.red,     Icon: TriangleAlert },
      success: { bg: '#D1FAE5', color: COLORS.emerald, Icon: CircleCheckBig },
      info:    { bg: '#EEF0FA', color: COLORS.primary, Icon: Info },
    }[tone]
    const stacked = buttons.length > 2

    return (
      <Modal visible={!!cfg} transparent animationType="fade" onRequestClose={() => setCfg(null)}>
        <View style={s.backdrop}>
          <View style={[s.card, { backgroundColor: theme.card }]}>
            {/* Icon header */}
            <View style={[s.iconWrap, { backgroundColor: toneMeta.bg }]}>
              <toneMeta.Icon size={24} color={toneMeta.color} />
            </View>

            {!!cfg?.title && <Text style={[s.title, { color: theme.text }]}>{cfg.title}</Text>}
            {!!cfg?.message && <Text style={[s.message, { color: theme.textSub }]}>{cfg.message}</Text>}

            <View style={[s.buttons, stacked && s.buttonsStacked]}>
              {buttons.map((b, i) => {
                const isDestructive = b.style === 'destructive'
                const isCancel      = b.style === 'cancel'
                const btnStyle = isCancel
                  ? [s.btnCancel, { backgroundColor: theme.chipBg, borderColor: theme.cardBorder }]
                  : isDestructive
                    ? { backgroundColor: COLORS.red }
                    : { backgroundColor: COLORS.primary }
                return (
                  <TouchableOpacity
                    key={i}
                    onPress={() => { setCfg(null); b.onPress?.() }}
                    style={[s.btn, btnStyle, stacked && s.btnStacked]}
                    activeOpacity={0.85}
                  >
                    <Text style={[s.btnText, { color: isCancel ? theme.textSub : COLORS.white }]}>{b.text}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        </View>
      </Modal>
    )
  }, [cfg])

  return { showAlert, AlertHost }
}

const s = StyleSheet.create({
  backdrop:       { flex: 1, backgroundColor: 'rgba(15,14,34,0.6)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36 },
  card:           { width: '100%', maxWidth: 330, borderRadius: 24, paddingTop: 24, paddingBottom: 20, paddingHorizontal: 22, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 16 },
  iconWrap:       { width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', marginBottom: 14 },
  title:          { fontSize: 17, ...FONTS.extrabold, marginBottom: 6, textAlign: 'center' },
  message:        { fontSize: 13, ...FONTS.regular, lineHeight: 20, marginBottom: 20, textAlign: 'center' },
  buttons:        { flexDirection: 'row', gap: 10, width: '100%' },
  buttonsStacked: { flexDirection: 'column' },
  btn:            { flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnStacked:     { width: '100%', flex: 0 },
  btnCancel:      { borderWidth: 1.5 },
  btnText:        { fontSize: 14, ...FONTS.bold },
})

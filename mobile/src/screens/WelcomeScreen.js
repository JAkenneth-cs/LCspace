import { View, Text, StyleSheet, TouchableOpacity, StatusBar, Image, Dimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { GraduationCap, ArrowRight } from 'lucide-react-native'
import { COLORS, FONTS } from '../lib/theme'

const HERO = require('../../assets/1.png')
const { width: SCREEN_W } = Dimensions.get('window')
const HERO_SIZE = SCREEN_W * 1.78
const GLOW_SIZE = SCREEN_W * 0.86

export default function WelcomeScreen({ navigation }) {
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.primary} />

      {/* Decorative background accents */}
      <View style={s.blobTop} />
      <View style={s.blobBottom} />

      <SafeAreaView style={s.safe}>
        {/* Brand */}
        <View style={s.brandRow}>
          <GraduationCap size={20} color={COLORS.accent} />
          <Text style={s.brand}>LCspace</Text>
        </View>

        {/* Hero — your 3D illustration */}
        <View style={s.hero}>
          <View style={s.heroGlow} />
          <Image source={HERO} style={s.heroImage} resizeMode="contain" />
        </View>

        {/* Copy */}
        <View style={s.copy}>
          <Text style={s.title}>The sky is the limit.</Text>
          <Text style={s.subtitle}>
            Reserve your space, collaborate in real time, and make every study session count.
          </Text>
        </View>

        {/* CTA */}
        <TouchableOpacity style={s.cta} activeOpacity={0.9} onPress={() => navigation.navigate('Login')}>
          <Text style={s.ctaText}>Get Started</Text>
          <ArrowRight size={18} color={COLORS.primary} />
        </TouchableOpacity>

        <Text style={s.footer}>USPF · Learning Commons Space</Text>
      </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.primary },
  blobTop: { position: 'absolute', top: -90, right: -70, width: 250, height: 250, borderRadius: 125, backgroundColor: 'rgba(245,201,0,0.08)' },
  blobBottom: { position: 'absolute', bottom: 30, left: -80, width: 230, height: 230, borderRadius: 115, backgroundColor: 'rgba(255,255,255,0.05)' },
  safe: { flex: 1, paddingHorizontal: 28, paddingVertical: 14, justifyContent: 'space-between' },

  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 },
  brand: { fontSize: 18, ...FONTS.extrabold, color: COLORS.white, letterSpacing: 0.3 },

  hero: { flex: 1, position: 'relative', justifyContent: 'center', alignItems: 'center', marginVertical: 8 },
  heroGlow: { position: 'absolute', width: GLOW_SIZE, height: GLOW_SIZE, borderRadius: GLOW_SIZE / 2, backgroundColor: 'rgba(255,255,255,0.06)' },
  heroImage: { width: HERO_SIZE, height: HERO_SIZE },

  copy: { marginBottom: 6 },
  title: { fontSize: 30, ...FONTS.extrabold, color: COLORS.white, lineHeight: 38, marginBottom: 12 },
  subtitle: { fontSize: 15, color: 'rgba(255,255,255,0.6)', lineHeight: 22 },

  cta: { backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 22 },
  ctaText: { fontSize: 16, ...FONTS.extrabold, color: COLORS.primary },
  footer: { fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 14, ...FONTS.medium },
})

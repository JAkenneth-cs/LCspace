import { useRef, useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, StatusBar, BackHandler } from 'react-native'
import { WebView } from 'react-native-webview'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { COLORS, FONTS } from '../lib/theme'

const SESSION_BASE_URL = 'https://lcspace-uspf-portal.web.app/session'

// Injected before page load:
// 1. Marks the page as running inside the mobile shell
// 2. Sets a mobile-friendly viewport
// 3. Hides the top bar (already shown natively) and fixes bottom padding
const INJECTED_JS = `
  (function() {
    if (window.__lcspacePatched) return;
    window.__lcspacePatched = true;
    window.__LCSPACE_MOBILE = true;

    // Ensure proper mobile viewport
    var meta = document.querySelector('meta[name=viewport]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

    // Inject mobile layout fixes
    var style = document.createElement('style');
    style.textContent = \`
      * { -webkit-tap-highlight-color: transparent; }
      body, html { overflow: hidden !important; height: 100% !important; }
      /* Shrink font sizes that are too large on mobile */
      .text-4xl { font-size: 1.5rem !important; }
      .text-3xl { font-size: 1.25rem !important; }
      /* Make video tiles fill better on portrait */
      video { object-fit: cover !important; }
      /* Ensure bottom bar doesn't get cut off */
      .h-16 { height: 4rem !important; padding-bottom: env(safe-area-inset-bottom, 0px); }
    \`;
    document.head.appendChild(style);
  })();
  true;
`

export default function CyberspaceScreen({ route, navigation }) {
  const bookingId = route?.params?.bookingId || ''
  const inviteId  = route?.params?.inviteId  || ''
  const url = inviteId
    ? `${SESSION_BASE_URL}?invite=${encodeURIComponent(inviteId)}`
    : bookingId
      ? `${SESSION_BASE_URL}?bookingId=${encodeURIComponent(bookingId)}`
      : SESSION_BASE_URL

  const webRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)

  // Android hardware back button: go back in WebView first, then leave screen
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (webRef.current) { webRef.current.goBack(); return true }
      return false
    })
    return () => sub.remove()
  }, [])

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.primary} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.headerBtn} hitSlop={10}>
          <ChevronLeft size={22} color={COLORS.white} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Cyberspace</Text>
          <Text style={s.subtitle}>Digital learning hub</Text>
        </View>
        <TouchableOpacity onPress={() => webRef.current?.reload()} style={s.headerBtn} hitSlop={10}>
          <RefreshCw size={18} color={COLORS.white} />
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1, backgroundColor: '#0b111a' }}>
        <WebView
          ref={webRef}
          source={{ uri: url }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // iOS: auto-grant camera/mic inside WebView
          mediaCapturePermissionGrantType="grant"
          // Android: auto-grant camera/mic permission requests
          onPermissionRequest={(request) => request.grant(request.resources)}
          allowsProtectedMedia
          injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
          onLoadStart={() => { setLoading(true); setError(false) }}
          onLoadEnd={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true) }}
          onHttpError={({ nativeEvent }) => {
            // Only treat actual server errors as failures, not redirects
            if (nativeEvent.statusCode >= 400) { setLoading(false); setError(true) }
          }}
          renderLoading={() => null}
          style={{ flex: 1, backgroundColor: '#0b111a' }}
        />

        {loading && (
          <View style={s.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={s.overlayText}>Loading Cyberspace…</Text>
          </View>
        )}
        {error && (
          <View style={s.overlay}>
            <Text style={s.errorTitle}>Couldn't load Cyberspace</Text>
            <Text style={s.errorBody}>Check your internet connection and try again.</Text>
            <TouchableOpacity onPress={() => { setError(false); setLoading(true); webRef.current?.reload() }} style={s.retryBtn}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: COLORS.primary },
  header:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: COLORS.primary },
  headerBtn:   { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  title:       { fontSize: 15, ...FONTS.extrabold, color: COLORS.white },
  subtitle:    { fontSize: 11, color: 'rgba(255,255,255,0.55)', ...FONTS.medium, marginTop: 1 },
  overlay:     { ...StyleSheet.absoluteFillObject, backgroundColor: '#0B0D1A', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  overlayText: { color: COLORS.white, fontSize: 13, ...FONTS.medium, marginTop: 12 },
  errorTitle:  { color: COLORS.white, fontSize: 16, ...FONTS.bold, marginBottom: 6 },
  errorBody:   { color: 'rgba(255,255,255,0.65)', fontSize: 13, textAlign: 'center', ...FONTS.regular, marginBottom: 18 },
  retryBtn:    { backgroundColor: COLORS.accent, paddingHorizontal: 28, paddingVertical: 11, borderRadius: 12 },
  retryText:   { color: COLORS.primary, fontSize: 14, ...FONTS.bold },
})

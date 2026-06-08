import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, Modal, StatusBar, KeyboardAvoidingView, Platform } from 'react-native'
import { collection, query, where, onSnapshot, orderBy, addDoc, serverTimestamp, doc, deleteDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { COLORS, FONTS } from '../lib/theme'
import { useTheme } from '../lib/ThemeContext'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Mail, Send, Plus, Trash2, Inbox, ChevronDown, MonitorPlay } from 'lucide-react-native'
import { useNavigation } from '@react-navigation/native'
import { useAlert } from '../components/AlertModal'
import { sanitizeText } from '../lib/validation'
import { checkRateLimit, resetRateLimit, formatRetryAfter } from '../lib/rateLimit'

export default function MailScreen({ profile }) {
  const { theme } = useTheme()
  const { showAlert, AlertHost } = useAlert()
  const navigation = useNavigation()
  const [inbox, setInbox] = useState([])
  const [sent, setSent] = useState([])
  const [tab, setTab] = useState('inbox')  // 'inbox' | 'sent'
  const [compose, setCompose] = useState(false)

  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  // Inbox: messages addressed to me (direct uid match OR broadcasts)
  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    const unsubMine = onSnapshot(
      query(collection(db, 'admin_messages'), where('recipient_uid', '==', uid)),
      snapMine => {
        const mine = snapMine.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.hidden_for_student)
        setInbox(prev => {
          const broadcasts = prev.filter(m => m.recipient_id === 'all')
          const merged = [...mine, ...broadcasts]
            .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
            .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
          return merged
        })
      }
    )
    const unsubBroadcast = onSnapshot(
      query(collection(db, 'admin_messages'), where('recipient_id', '==', 'all')),
      snapAll => {
        const broadcasts = snapAll.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.hidden_for_student)
        setInbox(prev => {
          const mine = prev.filter(m => m.recipient_uid === uid && m.recipient_id !== 'all')
          const merged = [...mine, ...broadcasts]
            .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
            .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
          return merged
        })
      }
    )
    return () => { unsubMine(); unsubBroadcast() }
  }, [])

  // Sent: messages I authored
  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    return onSnapshot(
      query(collection(db, 'admin_messages'), where('sender_uid', '==', uid)),
      snap => setSent(
        snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(m => !m.hidden_for_student)
          .sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0))
      )
    )
  }, [])

  const messages = tab === 'inbox' ? inbox : sent

  async function handleSend() {
    const cleanSubject = sanitizeText(subject)
    const cleanBody = sanitizeText(body)
    if (!cleanSubject || !cleanBody) { showAlert('Missing', 'Fill in subject and message.'); return }
    if (cleanSubject.length < 2 || cleanBody.length < 2) { showAlert('Too Short', 'Subject and message are too short.'); return }
    const rl = await checkRateLimit('message')
    if (!rl.allowed) {
      showAlert('Too Many Messages', `Please wait ${formatRetryAfter(rl.retryAfterMs)} before sending another.`)
      return
    }
    setSending(true)
    try {
      await addDoc(collection(db, 'admin_messages'), {
        subject: cleanSubject,
        message: cleanBody,
        direction: 'from_student',
        sender_uid: auth.currentUser.uid,
        sender_name: profile?.name || 'Student',
        sender_student_id: profile?.student_id || '',
        recipient_id: 'admin',
        recipient_uid: 'admin',
        type: 'student_message',
        created_at: serverTimestamp(),
      })
      setSubject(''); setBody(''); setCompose(false)
      resetRateLimit('message')
      showAlert('Sent', 'Your message was sent to admin.')
    } catch { showAlert('Error', 'Failed to send message.') }
    setSending(false)
  }

  async function handleDelete(id) {
    showAlert('Remove Message', 'Remove this message from your list? The record is still retained by the admin.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            await updateDoc(doc(db, 'admin_messages', id), {
              hidden_for_student: true,
              hidden_for_student_at: serverTimestamp(),
            })
          } catch { }
        }
      }
    ])
  }

  const fmtDate = ts => ts?.seconds
    ? new Date(ts.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ''
  const fmtDateFull = ts => ts?.seconds
    ? new Date(ts.seconds * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''

  const initials = name => (name || 'A').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  const senderColors = ['#EEF0FA', '#FEF3C7', '#D1FAE5', '#DBEAFE', '#FEE2E2']
  const senderColor = name => senderColors[(name?.charCodeAt(0) || 0) % senderColors.length]

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SafeAreaView style={[s.safe, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]} edges={['top']}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.type === 'dark' ? theme.bg : COLORS.primary}
        />

        {/* Header */}
        <View style={[s.header, { backgroundColor: theme.type === 'dark' ? theme.bg : COLORS.primary }]}>
          <View>
            <Text style={s.headerLabel}>MESSAGES</Text>
            <Text style={s.headerTitle}>Mailbox</Text>
          </View>
          <View style={s.headerRight}>
            <TouchableOpacity onPress={() => setCompose(true)} style={s.composeBtn} activeOpacity={0.85}>
              <Plus size={20} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Inbox / Sent tabs */}
        <View style={[s.tabRow, { backgroundColor: theme.filterWrap }]}>
          {[['inbox', 'Inbox', inbox.length], ['sent', 'Sent', sent.length]].map(([k, label, cnt]) => {
            const active = tab === k
            return (
              <TouchableOpacity key={k} onPress={() => { setTab(k); setExpandedId(null) }} style={[s.tabBtn, active && s.tabBtnActive]} activeOpacity={0.85}>
                <Text style={[s.tabText, { color: active ? COLORS.white : theme.textSub }]}>{label}</Text>
                {cnt > 0 && (
                  <View style={[s.tabBadge, { backgroundColor: active ? 'rgba(255,255,255,0.2)' : theme.chipBg }]}>
                    <Text style={[s.tabBadgeText, { color: active ? COLORS.white : theme.textSub }]}>{cnt}</Text>
                  </View>
                )}
              </TouchableOpacity>
            )
          })}
        </View>

        <ScrollView style={[s.scroll, { backgroundColor: theme.bg }]} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
          {messages.length === 0 ? (
            <View style={s.empty}>
              <View style={[s.emptyIconWrap, { backgroundColor: theme.card }]}>
                <Inbox size={28} color={COLORS.gray300} />
              </View>
              <Text style={s.emptyTitle}>{tab === 'inbox' ? 'No messages yet' : 'No sent messages yet'}</Text>
              <Text style={s.emptySubtitle}>{tab === 'inbox' ? 'Admin notifications will appear here' : 'Messages you send to admin will appear here'}</Text>
              <TouchableOpacity onPress={() => setCompose(true)} style={[s.composePromptBtn, { backgroundColor: theme.card, borderColor: theme.cardBorder }]}>
                <Text style={s.composePromptText}>Send a message to admin</Text>
              </TouchableOpacity>
            </View>
          ) : messages.map(m => {
            const isSent = tab === 'sent'
            const isExpanded = expandedId === m.id
            const displayName = isSent ? 'To: Admin' : (m.sender_name || 'Admin')
            const bg = senderColor(displayName)
            return (
              <View key={m.id} style={[s.card, { backgroundColor: theme.card }]}>
                {/* Header row — tap to expand/collapse */}
                <TouchableOpacity
                  style={s.cardRow}
                  onPress={() => setExpandedId(isExpanded ? null : m.id)}
                  activeOpacity={0.75}
                >
                  <View style={[s.senderAvatar, { backgroundColor: bg }]}>
                    <Text style={s.senderInitials}>{isSent ? 'AD' : initials(displayName)}</Text>
                  </View>
                  <View style={s.cardContent}>
                    <View style={s.cardTop}>
                      <Text style={[s.senderName, { color: theme.text }]} numberOfLines={1}>{displayName}</Text>
                      <Text style={s.cardDate}>{fmtDate(m.created_at)}</Text>
                    </View>
                    <Text style={[s.cardSubject, { color: theme.text }]} numberOfLines={1}>{m.subject}</Text>
                    {!isExpanded && (
                      <Text style={s.cardPreview} numberOfLines={1}>{m.message}</Text>
                    )}
                  </View>
                  <View style={s.cardActions}>
                    <ChevronDown
                      size={15}
                      color={COLORS.gray400}
                      style={{ transform: [{ rotate: isExpanded ? '180deg' : '0deg' }] }}
                    />
                    <TouchableOpacity onPress={() => handleDelete(m.id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={{ marginTop: 6 }}>
                      <Trash2 size={13} color={COLORS.gray300} />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>

                {/* Expanded body */}
                {isExpanded && (
                  <View style={s.expandBody}>
                    <View style={[s.expandDivider, { backgroundColor: theme.cardBorder || COLORS.gray100 }]} />
                    <Text style={[s.expandText, { color: theme.text }]}>{m.message}</Text>
                    <Text style={[s.expandMeta, { color: theme.textSub || COLORS.gray400 }]}>{fmtDateFull(m.created_at)}</Text>
                    {m.type === 'session_invite' && m.session_id && (
                      <TouchableOpacity
                        style={s.joinBtn}
                        activeOpacity={0.85}
                        onPress={() => navigation.navigate('Cyberspace', { inviteId: m.session_id })}
                      >
                        <MonitorPlay size={15} color={COLORS.white} />
                        <Text style={s.joinBtnText}>Join Cyberspace Session</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            )
          })}
        </ScrollView>

        {/* Compose — bottom sheet */}
        <Modal visible={compose} transparent animationType="slide" onRequestClose={() => setCompose(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.composeOverlay}>
            {/* Tap empty space above sheet to close */}
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setCompose(false)} />
            <View style={[s.composeSheet, { backgroundColor: theme.modal }]}>
              <View style={s.composeHandleArea}>
                <View style={[s.sheetHandle, { backgroundColor: theme.cardBorder }]} />
              </View>
              <View style={[s.composeHeader, { borderBottomColor: theme.cardBorder }]}>
                <View>
                  <Text style={[s.modalTitle, { color: theme.text }]}>New Message</Text>
                  <Text style={[s.modalSubtitle, { color: theme.textMuted }]}>Send to LCspace admin</Text>
                </View>
              </View>
              <ScrollView contentContainerStyle={s.composeBody} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <Text style={[s.inputLabel, { color: theme.textSub }]}>Subject</Text>
                <TextInput
                  style={[s.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={subject}
                  onChangeText={setSubject}
                  placeholder="What's your message about?"
                  placeholderTextColor={COLORS.gray400}
                />
                <Text style={[s.inputLabel, { color: theme.textSub }]}>Message</Text>
                <TextInput
                  style={[s.textArea, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text }]}
                  value={body}
                  onChangeText={setBody}
                  placeholder="Write your message here..."
                  placeholderTextColor={COLORS.gray400}
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                />
                <TouchableOpacity onPress={handleSend} style={s.sendBtn} disabled={sending} activeOpacity={0.85}>
                  {sending
                    ? <><ActivityIndicator color={COLORS.primary} /><Text style={[s.sendBtnText, { marginLeft: 6 }]}>Sending…</Text></>
                    : <><Send size={16} color={COLORS.primary} /><Text style={s.sendBtnText}>Send Message</Text></>
                  }
                </TouchableOpacity>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>


        <AlertHost />
      </SafeAreaView>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.primary },
  scroll: { flex: 1, backgroundColor: '#F0F2F8' },
  list: { padding: 16, paddingBottom: 104, gap: 10 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18 },
  headerLabel: { fontSize: 10, ...FONTS.bold, color: 'rgba(245,201,0,0.7)', letterSpacing: 1.5, marginBottom: 2 },
  headerTitle: { fontSize: 22, ...FONTS.extrabold, color: COLORS.white },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  composeBtn: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.accent, justifyContent: 'center', alignItems: 'center' },

  tabRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, gap: 8 },
  tabBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, backgroundColor: COLORS.gray100 },
  tabBtnActive: { backgroundColor: COLORS.primary },
  tabText: { fontSize: 12, ...FONTS.bold },
  tabBadge: { minWidth: 18, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabBadgeText: { fontSize: 10, ...FONTS.bold },

  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyIconWrap: { width: 68, height: 68, borderRadius: 22, backgroundColor: COLORS.white, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2, marginBottom: 4 },
  emptyTitle: { fontSize: 15, ...FONTS.semibold, color: COLORS.gray700 },
  emptySubtitle: { fontSize: 13, color: COLORS.gray400 },
  composePromptBtn: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, backgroundColor: COLORS.white, borderWidth: 1.5, borderColor: COLORS.gray200 },
  composePromptText: { fontSize: 13, ...FONTS.semibold, color: COLORS.primary },

  card: { backgroundColor: COLORS.white, borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14 },
  senderAvatar: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  senderInitials: { fontSize: 15, ...FONTS.extrabold, color: COLORS.primary },
  cardContent: { flex: 1 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  senderName: { fontSize: 13, ...FONTS.bold, color: COLORS.gray900 },
  cardDate: { fontSize: 11, color: COLORS.gray400 },
  cardSubject: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray700, marginBottom: 2 },
  cardPreview: { fontSize: 12, color: COLORS.gray400, lineHeight: 17 },
  cardActions: { alignItems: 'center', gap: 2, paddingTop: 2 },
  expandBody: { paddingHorizontal: 14, paddingBottom: 16 },
  expandDivider: { height: 1, marginBottom: 12 },
  expandText: { fontSize: 14, lineHeight: 22, color: COLORS.gray700, marginBottom: 10 },
  expandMeta: { fontSize: 11, color: COLORS.gray400, marginBottom: 12 },
  joinBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16 },
  joinBtnText: { fontSize: 13, ...FONTS.bold, color: COLORS.white },

  // Compose bottom sheet
  composeOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  composeSheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 32 },
  composeHandleArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 6, paddingHorizontal: 60 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12, backgroundColor: COLORS.gray200 },
  composeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, marginBottom: 2 },
  composeBody: { padding: 18, paddingBottom: 8 },
  modalTitle: { fontSize: 16, ...FONTS.bold, color: COLORS.gray900, marginBottom: 2 },
  modalSubtitle: { fontSize: 12, color: COLORS.gray400 },
  closeBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: COLORS.gray100, justifyContent: 'center', alignItems: 'center' },
  inputLabel: { fontSize: 13, ...FONTS.semibold, color: COLORS.gray700, marginBottom: 8 },
  input: { backgroundColor: COLORS.gray50, borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 14, color: COLORS.gray900, marginBottom: 18 },
  textArea: { backgroundColor: COLORS.gray50, borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 14, color: COLORS.gray900, marginBottom: 22, minHeight: 150 },
  sendBtn: { backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 15, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  sendBtnText: { fontSize: 15, ...FONTS.bold, color: COLORS.primary },
})

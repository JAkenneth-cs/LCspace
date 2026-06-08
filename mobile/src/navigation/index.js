import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { ActivityIndicator, View, Text, StyleSheet } from 'react-native'
import { COLORS } from '../lib/theme'
import { ThemeProvider, useTheme } from '../lib/ThemeContext'

// Screens
import WelcomeScreen from '../screens/WelcomeScreen'
import LoginScreen from '../screens/LoginScreen'
import HomeScreen from '../screens/HomeScreen'
import ReserveScreen from '../screens/ReserveScreen'
import BookingsScreen from '../screens/BookingsScreen'
import MailScreen from '../screens/MailScreen'
import ProfileScreen from '../screens/ProfileScreen'
import CyberspaceScreen from '../screens/CyberspaceScreen'

// Icons
import { Home, Calendar, ClipboardList, Mail, User } from 'lucide-react-native'

const Stack = createNativeStackNavigator()
const Tab = createBottomTabNavigator()

const TAB_ICONS = { Home, Reserve: Calendar, Bookings: ClipboardList, Mail, Profile: User }

function TabNavigator({ profile }) {
  const { theme } = useTheme()
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarShowLabel: true,
        tabBarActiveTintColor: theme.type === 'dark' ? theme.text : COLORS.primary,
        tabBarInactiveTintColor: theme.type === 'dark' ? 'rgba(255,255,255,0.4)' : COLORS.gray400,
        tabBarStyle: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 16,
          marginHorizontal: 18,
          backgroundColor: theme.card,
          borderTopWidth: 0,
          height: 60,
          borderRadius: 22,
          paddingTop: 6,
          paddingBottom: 6,
          shadowColor: '#000',
          shadowOpacity: 0.12,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 12,
          overflow: 'hidden',
        },
        tabBarBackground: () => null,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 1 },
        tabBarIcon: ({ focused }) => {
          const Icon = TAB_ICONS[route.name]
          const iconColor = focused
            ? (theme.type === 'dark' ? theme.text : COLORS.primary)
            : (theme.type === 'dark' ? 'rgba(255,255,255,0.4)' : COLORS.gray400)
          return (
            <View style={[tab.pill, focused && tab.pillActive]}>
              <Icon size={20} color={iconColor} />
            </View>
          )
        },
      })}
    >
      <Tab.Screen name="Home" children={() => <HomeScreen profile={profile} />} />
      <Tab.Screen name="Reserve" children={({ route }) => <ReserveScreen profile={profile} route={route} />} />
      <Tab.Screen name="Bookings" children={() => <BookingsScreen profile={profile} />} />
      <Tab.Screen name="Mail" children={() => <MailScreen profile={profile} />} />
      <Tab.Screen name="Profile" children={() => <ProfileScreen profile={profile} />} />
    </Tab.Navigator>
  )
}

export default function Navigation() {
  const [user, setUser] = useState(undefined)
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    let unsubProfile = null
    const unsubAuth = onAuthStateChanged(auth, u => {
      setUser(u)
      if (unsubProfile) { unsubProfile(); unsubProfile = null }
      if (u) {
        unsubProfile = onSnapshot(doc(db, 'users', u.uid), snap => {
          if (snap.exists()) setProfile({ uid: u.uid, ...snap.data() })
        })
      } else {
        setProfile(null)
      }
    })
    return () => { unsubAuth(); if (unsubProfile) unsubProfile() }
  }, [])

  if (user === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.primary }}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={{ color: COLORS.accent, marginTop: 12, fontSize: 14, fontWeight: '500' }}>Loading LCspace…</Text>
      </View>
    )
  }

  return (
    <ThemeProvider>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {!user ? (
            <>
              <Stack.Screen name="Welcome" component={WelcomeScreen} />
              <Stack.Screen name="Login" component={LoginScreen} />
            </>
          ) : (
            <>
              <Stack.Screen name="Main" children={() => <TabNavigator profile={profile} />} />
              <Stack.Screen name="Cyberspace" component={CyberspaceScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </ThemeProvider>
  )
}

const tab = StyleSheet.create({
  pill: { width: 44, height: 30, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  pillActive: { backgroundColor: COLORS.accent },
})
